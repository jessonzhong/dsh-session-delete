/**
 * Host half of `dsh-session-delete`.
 *
 * Registers the `sessionDelete` Cordis service, its Typert invocation
 * descriptor (read by `ctx.typert.local` for strict Remote dispatch), and the
 * `typertRemote` binding the API Gateway validates on every call. The delete
 * operation:
 *
 *   1. stops running work through the registry's archive gate
 *      (`workspaceRegistry.archiveSession(id, { stopActivity: true })`), which
 *      also durably blocks later wake-ups;
 *   2. best-effort closes this session's open persistence handles so its files
 *      can be removed while the Host is running;
 *   3. removes the stored session directory under the session-persistence root
 *      and the persisted projection-cache file;
 *   4. detaches the session from every workspace record and clears its
 *      registry-global pin/archive membership, which the workspace follow feed
 *      publishes so the sidebar row disappears in every open page.
 *
 * The sqlite search index is derived and drops sessions that leave the
 * persistence listing on its next sync, so it needs no explicit cleanup.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const PACKAGE_NAME = "dsh-session-delete";
const SERVICE_KEY = "sessionDelete";
const NAMESPACE = "sessionDelete";
const ENDPOINT = `${NAMESPACE}/delete`;

/** Wire schema of one delete request. */
const requestSchema = () =>
	z.object({
		sessionId: z.string().min(1).describe("Exact Session id, as listed in the sidebar."),
		stopActivity: z.boolean().optional().describe("Stop running work instead of refusing; omission defaults to true.")
	});

/** Wire schema of the delete outcome. */
const resultSchema = () =>
	z.object({
		ok: z.boolean().describe("Whether the Session was found and removed from every registry."),
		sessionId: z.string().describe("The requested Session id."),
		stopped: z.boolean().describe("Whether the archive gate stopped (or durably blocked) running work."),
		filesRemoved: z.boolean().describe("Whether every stored artifact was removed."),
		filesRemaining: z.array(z.string()).describe("Host paths that could not be removed, usually held open by a live handle."),
		memoryResident: z.boolean().describe("Whether an in-memory live copy could not be torn down; it clears on the next Harness restart."),
		message: z.string().optional().describe("Failure reason when ok is false.")
	});

/** Build a strict Typert codec around a lazy Zod factory. */
function strictCodec(typeSymbol, create, description, jsonSchema) {
	return {
		mode: "strict",
		typeSymbol,
		create,
		description,
		jsonSchema
	};
}

const requestCodec = () =>
	strictCodec(
		`${PACKAGE_NAME}/types#SessionDeleteRequest`,
		requestSchema,
		"which Session to delete and whether to stop its running work.",
		{
			type: "object",
			properties: {
				sessionId: { type: "string", description: "Exact Session id, as listed in the sidebar." },
				stopActivity: { type: "boolean", description: "Stop running work instead of refusing; omission defaults to true." }
			},
			required: ["sessionId"],
			additionalProperties: false
		}
	);

const resultCodec = () =>
	strictCodec(
		`${PACKAGE_NAME}/types#SessionDeleteResult`,
		resultSchema,
		"deletion outcome: registry removal, stop status, and any files that could not be removed.",
		{
			type: "object",
			properties: {
				ok: { type: "boolean" },
				sessionId: { type: "string" },
				stopped: { type: "boolean" },
				filesRemoved: { type: "boolean" },
				filesRemaining: { type: "array", items: { type: "string" } },
				memoryResident: { type: "boolean" },
				message: { type: "string" }
			},
			required: ["ok", "sessionId", "stopped", "filesRemoved", "filesRemaining", "memoryResident"],
			additionalProperties: false
		}
	);

/** The Host invocation descriptor read by strict Remote dispatch. */
const deleteInvocation = {
	id: `${PACKAGE_NAME}#${ENDPOINT}`,
	service: SERVICE_KEY,
	namespace: NAMESPACE,
	method: "delete",
	description: "Permanently delete one Session: stop its running work, remove its stored data, and drop its registry rows.",
	invocation: { kind: "direct" },
	parameters: [
		{
			name: "request",
			description: "which Session to delete and whether to stop its running work.",
			wire: "request",
			source: "json",
			codec: requestCodec(),
			strictCodec: requestCodec()
		}
	],
	cancellation: { parameter: "signal" },
	result: resultCodec()
};

/** The `./typert`-style manifest registered into `ctx.typert`. */
const TYPERT = {
	package: PACKAGE_NAME,
	face: "host",
	schemas: [],
	model: {
		services: [
			{
				key: SERVICE_KEY,
				exportName: "sessionDelete",
				tags: [],
				description: "Permanently deletes one Session's registry rows and stored data.",
				members: [
					{
						name: "delete",
						signature: "delete(request: SessionDeleteRequest, signal?: AbortSignal): Promise<SessionDeleteResult>",
						kind: "method"
					}
				],
				types: [
					{
						name: "SessionDeleteResult",
						declaration:
							"interface SessionDeleteResult { ok: boolean; sessionId: string; stopped: boolean; filesRemoved: boolean; filesRemaining: string[]; message?: string }"
					}
				]
			}
		],
		events: [],
		objects: []
	},
	invocations: [deleteInvocation]
};

/**
 * Encode an arbitrary string as one safe path segment, exactly as
 * `@deepseek-ai/dsh-session-persistence-jsonl` does before filesystem use
 * (safe `[A-Za-z0-9._-]` units stay literal; every other unit, including `~`,
 * becomes `~XXXX`).
 */
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += "~" + code.toString(16).toUpperCase().padStart(4, "0");
	}
	return out;
}

async function isDirectory(path) {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** `rm -rf` with a few retries: a live Windows handle may release just after the stop. */
async function removeWithRetry(target, attempts = 3, delayMs = 500) {
	let lastError;
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			await rm(target, { recursive: true, force: true });
			return true;
		} catch (error) {
			lastError = error;
			if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
		}
	}
	return lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Resolve the DeepSeek Harness home (`$DSH_HOME`, else `~/.dsh`). */
function dshHome() {
	const configured = typeof process.env.DSH_HOME === "string" ? process.env.DSH_HOME.trim() : "";
	return configured !== "" ? configured : join(homedir(), ".dsh");
}

/**
 * The deletion itself. Steps never throw for one session's bookkeeping: every
 * outcome is collected so registry rows are always cleaned up and the caller
 * learns exactly what remained.
 */
async function deleteSession(ctx, request, signal) {
	const sessionId = request.sessionId;
	const stopActivity = request.stopActivity !== false;
	const result = {
		ok: false,
		sessionId,
		stopped: false,
		filesRemoved: true,
		filesRemaining: [],
		memoryResident: false,
		message: undefined
	};
	signal?.throwIfAborted?.();

	const registry = ctx.get("workspaceRegistry");
	const persistence = ctx.get("sessionPersistence");
	const sessionStore = ctx.get("sessions");
	const agentStore = ctx.get("agents");

	// 1. Existence: the live store (a fresh fork/create may not be materialized
	// yet), a stored log, a workspace accounting slot (raw record included, even
	// when the membership getter filters the id), or registry-global sets.
	let stored;
	if (persistence !== undefined) {
		try {
			stored = await persistence.stat(sessionId);
		} catch {
			stored = undefined;
		}
	}
	let live;
	try {
		live = sessionStore?.get?.(sessionId);
	} catch {
		live = undefined;
	}
	const owners = [];
	if (registry !== undefined) {
		for (const workspace of registry.list()) {
			try {
				const raw = workspace.record?.sessionIds;
				if (workspace.sessionIds.includes(sessionId) || raw?.includes(sessionId)) owners.push(workspace);
			} catch {
				/* an unreadable workspace record cannot own a row the user sees */
			}
		}
	}
	const inGlobalSet =
		registry !== undefined &&
		(registry.archivedSessionIds.includes(sessionId) || registry.pinnedSessionIds.includes(sessionId));
	if (live === undefined && stored === undefined && owners.length === 0 && !inGlobalSet) {
		result.message = `session ${JSON.stringify(sessionId)} was not found`;
		return result;
	}

	// 2. Stop running work through the archive gate (also blocks later wake-ups).
	if (registry !== undefined && stopActivity) {
		try {
			await registry.archiveSession(sessionId, { stopActivity: true });
			result.stopped = true;
		} catch (error) {
			// Already-archived resolves without writing; an unknown session was
			// checked above. Anything else should not block removing the data.
			ctx.logger?.warn?.(`session-delete: stopping session ${JSON.stringify(sessionId)} reported: ${String(error)}`);
		}
	}
	signal?.throwIfAborted?.();

	// 3. Tear down a live in-memory copy so the row leaves the session list now
	// (session/disposed) and nothing can re-materialize the log later. This
	// mirrors the agent factory's teardown order; every step is best-effort and
	// feature-detected because these are internal shapes.
	try {
		const agent = agentStore?.get?.(sessionId);
		if (agent !== undefined) {
			try {
				await agent.cancel?.({ kind: "disposed" });
			} catch (error) {
				ctx.logger?.warn?.(`session-delete: cancelling agent ${JSON.stringify(sessionId)} failed: ${String(error)}`);
			}
			try {
				await agent.whenIdle?.();
			} catch (error) {
				ctx.logger?.warn?.(`session-delete: draining agent ${JSON.stringify(sessionId)} failed: ${String(error)}`);
			}
			try {
				await agent.scope?.dispose?.();
			} catch (error) {
				ctx.logger?.warn?.(`session-delete: disposing agent scope ${JSON.stringify(sessionId)} failed: ${String(error)}`);
			}
		}
	} catch (error) {
		ctx.logger?.warn?.(`session-delete: live agent teardown for ${JSON.stringify(sessionId)} failed: ${String(error)}`);
	}

	// 4. Best-effort close of this session's open persistence handles.
	const tracker = persistence !== undefined && typeof persistence === "object" ? persistence.tracker : undefined;
	if (tracker !== undefined && tracker.openHandles instanceof Set) {
		for (const handle of [...tracker.openHandles]) {
			if (handle === undefined || handle === null || handle.id !== sessionId) continue;
			try {
				await handle.close();
			} catch (error) {
				ctx.logger?.warn?.(`session-delete: closing a handle for ${JSON.stringify(sessionId)} failed: ${String(error)}`);
			}
		}
	}

	// 5. Detach the live store entries (emits session/disposed and
	// agent/disposed, which removes the row from the session list). The
	// factory's own later teardown re-runs these idempotent steps harmlessly.
	try {
		const entry = agentStore?.store instanceof Map ? agentStore.store.get(sessionId) : undefined;
		if (entry !== undefined) agentStore.detachEntered(entry);
	} catch (error) {
		ctx.logger?.warn?.(`session-delete: detaching agent entry ${JSON.stringify(sessionId)} failed: ${String(error)}`);
	}
	try {
		const session = sessionStore?.get?.(sessionId);
		if (session !== undefined) {
			let entry;
			try {
				entry = sessionStore.liveEntryFor?.(session);
			} catch {
				entry = undefined;
			}
			entry ??= sessionStore.store instanceof Map ? sessionStore.store.get(sessionId) : undefined;
			if (entry !== undefined && typeof entry.detach === "function") entry.detach();
		}
	} catch (error) {
		ctx.logger?.warn?.(`session-delete: detaching session entry ${JSON.stringify(sessionId)} failed: ${String(error)}`);
	}

	// 6. Stored artifacts: <root>/<project-key>/<encoded id>/ plus the projection cache.
	const root =
		typeof persistence?.root === "string" && persistence.root !== ""
			? persistence.root
			: join(dshHome(), "sessions");
	let encoded = sessionId;
	try {
		encoded = encodeSegment(sessionId);
	} catch {
		/* keep the raw id for the scan */
	}
	const remaining = [];
	try {
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const dir = join(root, entry.name, encoded);
			if (!(await isDirectory(dir))) continue;
			const outcome = await removeWithRetry(dir);
			if (outcome !== true) {
				remaining.push(dir);
				ctx.logger?.warn?.(`session-delete: removing ${dir} failed: ${String(outcome)}`);
			}
		}
	} catch {
		/* an absent root means nothing is stored */
	}
	const cacheDir = join(dshHome(), "storages", "session_projcache", "sessions");
	for (const name of new Set([`${encoded}.json`, `${sessionId}.json`])) {
		const cachePath = join(cacheDir, name);
		try {
			await rm(cachePath, { force: true });
		} catch (error) {
			remaining.push(cachePath);
			ctx.logger?.warn?.(`session-delete: removing ${cachePath} failed: ${String(error)}`);
		}
	}
	result.filesRemaining = remaining;
	result.filesRemoved = remaining.length === 0;

	// 7. Registry rows: the workspace follow feed publishes each write, so the
	// sidebar row disappears everywhere even when some files remain.
	if (registry !== undefined) {
		for (const workspace of owners) {
			try {
				await workspace.detachSession(sessionId);
			} catch (error) {
				ctx.logger?.warn?.(`session-delete: detaching ${JSON.stringify(sessionId)} from workspace failed: ${String(error)}`);
			}
		}
		try {
			await registry.unpinSession(sessionId);
		} catch (error) {
			ctx.logger?.warn?.(`session-delete: unpinning ${JSON.stringify(sessionId)} failed: ${String(error)}`);
		}
	}

	// 8. A surviving in-memory copy (internal teardown unavailable) is kept
	// archived so the default list hides it, and is reported; it clears on the
	// next Harness restart because nothing durable remains.
	let stillLive;
	try {
		stillLive = sessionStore?.get?.(sessionId) !== undefined || agentStore?.get?.(sessionId) !== undefined;
	} catch {
		stillLive = false;
	}
	result.memoryResident = stillLive === true;
	if (registry !== undefined) {
		if (stillLive) {
			try {
				await registry.archiveSession(sessionId, { stopActivity: true });
			} catch (error) {
				ctx.logger?.warn?.(`session-delete: hiding live leftover ${JSON.stringify(sessionId)} failed: ${String(error)}`);
			}
		} else {
			try {
				await registry.unarchiveSession(sessionId);
			} catch (error) {
				ctx.logger?.warn?.(`session-delete: unarchiving ${JSON.stringify(sessionId)} failed: ${String(error)}`);
			}
		}
	}

	result.ok = true;
	return result;
}

/** The service object the Gateway dispatches to. */
function createService(ctx) {
	const service = {
		delete(request, signal) {
			return deleteSession(ctx, request, signal);
		}
	};
	// The binding shape `bindTypertRemote()` produces: the Gateway validates
	// `service`/`serviceKey`/`namespace` on every invocation.
	service.typertRemote = Object.freeze({
		service,
		serviceKey: SERVICE_KEY,
		namespace: NAMESPACE
	});
	return service;
}

/** Host plugin entry: register the service, its strict descriptor, and nothing else. */
export function apply(ctx) {
	ctx.reflect.provide(SERVICE_KEY, createService(ctx));
	const typert = ctx.get("typert");
	if (typert === undefined) {
		ctx.logger?.warn?.("session-delete: typert registry unavailable; Remote dispatch for sessionDelete/delete will not resolve");
		return;
	}
	ctx.effect(() => typert.register(TYPERT), "session-delete typert contribution");
}

/** Hard dependencies of the deletion operation. */
export const inject = ["typert", "workspaceRegistry", "sessionPersistence"];
