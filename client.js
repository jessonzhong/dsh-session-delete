/**
 * Client half of `dsh-session-delete`.
 *
 * Contributes:
 *   - a danger "Delete session…" row (order 500) into the session "..." menu
 *     (`sidebar.workspaces.session.menu.item`);
 *   - the confirmation dialog behind it in `shell.overlay`, following the
 *     host's archive-confirmation pattern (Modal focus/Escape behavior, danger
 *     confirm action);
 *   - the `sessionDelete/delete` Remote (mounted through `ctx.remote.$mount`)
 *     whose Host service stops running work, removes the stored session data,
 *     and drops its registry rows.
 *
 * Menu/modal markup and CSS are copied from the host UI primitives
 * (`MenuItemButton`, `Modal`, `Button`) under the plugin's own `sd_` class
 * prefix, using only `--dsw-alias-*` theme tokens.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-delete",
	factory(require) {
		const React = require("react");
		const zod = require("zod");
		const h = React.createElement;

		//#region remote-info (TypertRemoteInfo contract shape from @deepseek-ai/dsh-typert-protocol)
		/** Lazy assembly of generated Remote definitions using caller-supplied Zod; no runtime imports. */
		function createTypertRemoteInfo(spec, zodRuntime) {
			return new RemoteInfo(spec, zodRuntime);
		}
		class RemoteInfo {
			constructor(spec, zodRuntime) {
				this.spec = spec;
				this.zod = zodRuntime;
				this.index = undefined;
			}
			get package() {
				return this.spec.package;
			}
			get descriptors() {
				return this.resolve().descriptors;
			}
			get methods() {
				return this.resolve().methods;
			}
			resolve() {
				if (this.index !== undefined) return this.index;
				const zodRuntime = this.zod;
				const descriptors = [];
				const methods = Object.create(null);
				for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
					const separator = endpoint.indexOf("/");
					const namespace = endpoint.slice(0, separator);
					const method = endpoint.slice(separator + 1);
					const parameters = definition.parameters.map((parameter) => ({
						...parameter,
						wire: parameter.wire ?? parameter.name
					}));
					const descriptor = {
						...definition,
						id: `${this.spec.package}#${endpoint}`,
						namespace,
						method,
						parameters,
						result:
							definition.result.description === undefined
								? definition.result
								: new ResultValue(definition.result)
					};
					if (definition.invocation.kind === "direct") {
						const inputs = [];
						methods[endpoint] = Object.assign(descriptor, {
							input(options) {
								const strict = options?.strict === true;
								return (inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zodRuntime));
							},
							invoke(remote, input, signal) {
								const named = input;
								const values = parameters.map((parameter) => named[parameter.wire]);
								if (definition.cancellation !== undefined) values.push(signal);
								const receiver = Reflect.get(remote, namespace);
								return Reflect.get(receiver, method).apply(receiver, values);
							}
						});
					}
					descriptors.push(descriptor);
				}
				return (this.index = { descriptors, methods });
			}
		}
		function optional(parameter) {
			return parameter.source === "json" && parameter.acceptsUndefined === true;
		}
		class NamedInput {
			constructor(parameters, strict, zodRuntime) {
				this.parameters = parameters;
				this.strict = strict;
				this.zod = zodRuntime;
				this.schema = undefined;
				this.projection = undefined;
			}
			codec(parameter) {
				return this.strict ? parameter.strictCodec : parameter.codec;
			}
			create = () =>
				(this.schema ??= this.zod.strictObject(
					Object.fromEntries(
						this.parameters.map((parameter) => {
							const value = this.codec(parameter).create();
							return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()];
						})
					)
				));
			get jsonSchema() {
				return this.project().jsonSchema;
			}
			get jsonSchemaError() {
				return this.project().jsonSchemaError;
			}
			project() {
				if (this.projection !== undefined) return this.projection;
				const unavailable = this.parameters.find((parameter) => this.codec(parameter).jsonSchema === undefined);
				if (unavailable !== undefined)
					return (this.projection = {
						jsonSchemaError:
							this.codec(unavailable).jsonSchemaError ?? `No JSON Schema for parameter ${unavailable.wire}`
					});
				return (this.projection = {
					jsonSchema: {
						type: "object",
						properties: Object.fromEntries(
							this.parameters.map((parameter) => [
								parameter.wire,
								{
									...this.codec(parameter).jsonSchema,
									...(parameter.description === undefined ? {} : { description: parameter.description })
								}
							])
						),
						required: this.parameters
							.filter((parameter) => !optional(parameter))
							.map((parameter) => parameter.wire),
						additionalProperties: false
					}
				});
			}
		}
		class ResultValue {
			constructor(spec) {
				this.spec = spec;
				this.projection = undefined;
			}
			get mode() {
				return this.spec.mode;
			}
			get typeSymbol() {
				return this.spec.typeSymbol;
			}
			get create() {
				return this.spec.create;
			}
			get decode() {
				return this.spec.decode;
			}
			get encode() {
				return this.spec.encode;
			}
			get description() {
				return this.spec.description;
			}
			get jsonSchemaError() {
				return this.spec.jsonSchemaError;
			}
			get jsonSchema() {
				if (this.projection === undefined) {
					const schema = this.spec.jsonSchema;
					this.projection = {
						value:
							schema === undefined
								? undefined
								: { ...schema, description: this.spec.description }
					};
				}
				return this.projection.value;
			}
		}
		//#endregion

		//#region wire codecs (mirroring the Host half)
		const PACKAGE_NAME = "dsh-session-delete";
		function requestSchema() {
			return zod.z.strictObject({
				sessionId: zod.z.string().min(1).describe("Exact Session id, as listed in the sidebar."),
				stopActivity: zod.z
					.boolean()
					.optional()
					.describe("Stop running work instead of refusing; omission defaults to true.")
			});
		}
		function resultSchema() {
			return zod.z.strictObject({
				ok: zod.z.boolean(),
				sessionId: zod.z.string(),
				stopped: zod.z.boolean(),
				filesRemoved: zod.z.boolean(),
				filesRemaining: zod.z.array(zod.z.string()),
				memoryResident: zod.z.boolean(),
				message: zod.z.string().optional()
			});
		}
		function requestCodec() {
			return {
				mode: "strict",
				typeSymbol: `${PACKAGE_NAME}/types#SessionDeleteRequest`,
				create: requestSchema,
				description: "which Session to delete and whether to stop its running work.",
				jsonSchema: {
					type: "object",
					properties: {
						sessionId: { type: "string", description: "Exact Session id, as listed in the sidebar." },
						stopActivity: {
							type: "boolean",
							description: "Stop running work instead of refusing; omission defaults to true."
						}
					},
					required: ["sessionId"],
					additionalProperties: false
				}
			};
		}
		function resultCodec() {
			return {
				mode: "strict",
				typeSymbol: `${PACKAGE_NAME}/types#SessionDeleteResult`,
				create: resultSchema,
				description: "deletion outcome: registry removal, stop status, and any files that could not be removed.",
				jsonSchema: {
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
			};
		}
		const TYPERT_REMOTE = createTypertRemoteInfo(
			{
				package: PACKAGE_NAME,
				methods: {
					"sessionDelete/delete": {
						service: "sessionDelete",
						description:
							"Permanently delete one Session: stop its running work, remove its stored data, and drop its registry rows.",
						invocation: { kind: "direct" },
						parameters: [
							{
								name: "request",
								description: "which Session to delete and whether to stop its running work.",
								source: "json",
								codec: requestCodec(),
								strictCodec: requestCodec()
							}
						],
						cancellation: { parameter: "signal" },
						result: resultCodec()
					}
				}
			},
			zod.z
		);
		//#endregion

		//#region styles (copied from the host primitives under the sd_ prefix)
		const CSS = `
.sd_itemWrap{position:relative}
.sd_item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);text-align:left}
.sd_item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sd_item:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);outline:none}
.sd_item:disabled{opacity:.4;cursor:not-allowed}
.sd_itemIcon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;justify-content:center;color:var(--dsw-alias-menu-icon)}
.sd_itemIcon svg{width:14px;height:14px}
.sd_itemLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sd_danger,.sd_danger .sd_itemIcon{color:var(--dsw-alias-state-error-primary)}
.sd_danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.sd_danger:focus-visible:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}
.sd_separator{height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2)}
.sd_btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;border:none;border-radius:var(--dsw-radius-md);cursor:pointer;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);background:transparent;padding:0 14px}
.sd_btn:disabled{cursor:not-allowed;opacity:.4}
.sd_btnMd{height:36px}
.sd_btnGhost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sd_btnOutline{border:.5px solid var(--dsw-alias-border-l3);background:transparent}
.sd_btnOutline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sd_dangerAction:not(:disabled){color:var(--dsw-alias-state-error-primary)}
.sd_modalRoot{pointer-events:auto;position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:max(24px,var(--dsh-frame-overlay-top,24px)) 24px}
.sd_modalMask{position:absolute;inset:var(--dsh-frame-chrome-top,0px) 0 0;backdrop-filter:var(--dsw-mask-blur)}
.sd_modalMask:after{content:"";position:absolute;inset:0;background:var(--dsw-alias-bg-mask-1);animation:sd_modalEnter var(--ds-transition-duration) var(--ds-ease-in-out)}
.sd_modalDialog{box-sizing:border-box;position:relative;z-index:1;display:flex;flex-direction:column;gap:20px;width:min(440px,100%);max-height:100%;padding:0 0 24px;overflow:hidden;border:0;border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-2);box-shadow:var(--dsw-elevation-prominent);animation:sd_modalEnter var(--ds-transition-duration) var(--ds-ease-in-out)}
@keyframes sd_modalEnter{0%{opacity:0}to{opacity:1}}
.sd_modalDialog:focus{outline:none}
.sd_modalContent{display:flex;flex-direction:column;width:100%;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.sd_modalHeader{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:22px 14px 12px 24px}
.sd_modalTitle{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}
.sd_modalClose{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary)}
.sd_modalClose:hover{background:var(--dsw-alias-interactive-bg-hover)}
.sd_modalDescription{margin:0;padding:0 24px;font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary)}
.sd_modalBody{display:flex;flex-direction:column;min-width:0;margin-top:20px;padding:0 24px}
.sd_modalFooter{display:flex;align-items:center;justify-content:flex-end;gap:8px;padding:0 24px}
.sd_warning{display:flex;align-items:flex-start;gap:10px;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:22px}
.sd_warning p{margin:0}
.sd_warningIcon{flex:none;margin-top:2px;color:var(--dsw-alias-state-error-primary)}
.sd_status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.sd_error{color:var(--dsw-alias-state-error-primary);margin-top:8px;font-size:12px;line-height:18px}
`;
		function insertStyles(css) {
			if (typeof document === "undefined") return () => {};
			const tag = document.createElement("style");
			tag.dataset.plugin = PACKAGE_NAME;
			tag.textContent = css;
			document.head.appendChild(tag);
			return () => {
				tag.remove();
			};
		}
		//#endregion

		//#region icons (trash and warning follow the host icon set; close is drawn locally)
		function TrashIcon(props) {
			const size = props?.size ?? 14;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					xmlns: "http://www.w3.org/2000/svg",
					"aria-hidden": true,
					strokeWidth: 1
				},
				h("path", { d: "M1.28149 3.88831H14.7187", stroke: "currentColor" }),
				h("path", {
					d: "M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833",
					stroke: "currentColor"
				}),
				h("path", {
					d: "M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831",
					stroke: "currentColor"
				}),
				h("path", { d: "M6.44946 6.98926V11.1238", stroke: "currentColor" }),
				h("path", { d: "M9.55054 6.98926V11.1238", stroke: "currentColor" })
			);
		}
		function WarningIcon(props) {
			const size = props?.size ?? 16;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					xmlns: "http://www.w3.org/2000/svg",
					"aria-hidden": true,
					strokeWidth: 1
				},
				h("path", {
					d: "M8 14.5C11.5899 14.5 14.5 11.5899 14.5 8C14.5 4.41015 11.5899 1.5 8 1.5C4.41015 1.5 1.5 4.41015 1.5 8C1.5 11.5899 4.41015 14.5 8 14.5Z",
					stroke: "currentColor"
				}),
				h("path", { d: "M8 4.29199V9.79199", stroke: "currentColor" }),
				h("path", { d: "M8 10.708V11.708", stroke: "currentColor" })
			);
		}
		function CloseIcon(props) {
			const size = props?.size ?? 14;
			return h(
				"svg",
				{
					width: size,
					height: size,
					viewBox: "0 0 16 16",
					fill: "none",
					xmlns: "http://www.w3.org/2000/svg",
					"aria-hidden": true,
					strokeWidth: 1.2
				},
				h("path", { d: "M3.7 3.7L12.3 12.3", stroke: "currentColor", strokeLinecap: "round" }),
				h("path", { d: "M12.3 3.7L3.7 12.3", stroke: "currentColor", strokeLinecap: "round" })
			);
		}
		//#endregion

		//#region copied primitives (MenuItemButton / Button / Modal behavior)
		function MenuItemButton({ children, icon, danger, separatorBefore, disabled, onSelect }) {
			return h(
				"div",
				{ className: "sd_itemWrap" },
				separatorBefore ? h("div", { className: "sd_separator", role: "separator" }) : null,
				h(
					"button",
					{
						type: "button",
						role: "menuitem",
						className: danger ? "sd_item sd_danger" : "sd_item",
						disabled,
						onClick: onSelect
					},
					icon !== undefined ? h("span", { className: "sd_itemIcon" }, icon) : null,
					h("span", { className: "sd_itemLabel" }, children)
				)
			);
		}
		function Button({ variant = "ghost", size = "md", className, children, ...rest }) {
			return h(
				"button",
				{
					type: "button",
					className: ["sd_btn", `sd_btn_${variant}`, `sd_btn_${size}`, className].filter(Boolean).join(" "),
					...rest
				},
				children
			);
		}
		/** Modal focus/Escape behavior copied from the host Modal primitive. */
		function useModalBehavior(ref, open, onClose) {
			const onCloseRef = React.useRef(onClose);
			onCloseRef.current = onClose;
			React.useLayoutEffect(() => {
				const node = ref.current;
				if (!open || node === null) return;
				const doc = node.ownerDocument;
				const previous = doc.activeElement;
				const focusables =
					'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]';
				const target = node.querySelector("[data-modal-autofocus]") ?? node.querySelector(focusables) ?? node;
				if (!node.contains(doc.activeElement)) target.focus?.();
				const onKeyDown = (event) => {
					if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return;
					if (event.key === "Escape" && !event.shiftKey) {
						event.preventDefault();
						if (!event.repeat) onCloseRef.current();
						return;
					}
					if (event.key !== "Tab") return;
					const items = [...node.querySelectorAll(focusables)].filter(
						(el) => el.closest("[inert], [hidden]") === null
					);
					const first = items[0] ?? node;
					const last = items[items.length - 1] ?? node;
					const active = doc.activeElement;
					const wrap = event.shiftKey ? active === first : active === last;
					if (active === node || !node.contains(active) || wrap) {
						event.preventDefault();
						(event.shiftKey ? last : first).focus();
					}
				};
				doc.addEventListener("keydown", onKeyDown);
				return () => {
					doc.removeEventListener("keydown", onKeyDown);
					const restore = previous instanceof HTMLElement && previous.isConnected ? previous : null;
					restore?.focus?.();
				};
			}, [ref, open]);
		}
		function Modal({ open, onClose, title, closeLabel, description, children, footer, className }) {
			const ref = React.useRef(null);
			useModalBehavior(ref, open, onClose);
			if (!open) return null;
			return h(
				"div",
				{ className: "sd_modalRoot", role: "presentation" },
				h("div", {
					className: "sd_modalMask",
					"aria-hidden": "true",
					onClick: onClose
				}),
				h(
					"div",
					{
						ref,
						tabIndex: -1,
						className: className ? `sd_modalDialog ${className}` : "sd_modalDialog",
						role: "dialog",
						"aria-modal": "true",
						"aria-label": title
					},
					h(
						"div",
						{ className: "sd_modalContent" },
						h(
							"div",
							{ className: "sd_modalHeader" },
							h("h2", { className: "sd_modalTitle" }, title),
							h(
								"button",
								{
									type: "button",
									className: "sd_modalClose",
									"aria-label": closeLabel,
									onClick: onClose
								},
								h(CloseIcon, { size: 14 })
							)
						),
						description !== undefined && description !== ""
							? h("p", { className: "sd_modalDescription" }, description)
							: null,
						h("div", { className: "sd_modalBody" }, children)
					),
					footer !== undefined ? h("div", { className: "sd_modalFooter" }, footer) : null
				)
			);
		}
		//#endregion

		//#region locale
		const NS = "sessionDelete";
		const en = {
			"menu.deleteSession": "Delete session\u2026",
			"confirm.title": "Permanently delete this session?",
			"confirm.desc": "This permanently deletes \u201c{title}\u201d and its entire stored conversation history. This cannot be undone.",
			"confirm.warning": "Any running work in this session will be stopped first. Archived sessions are deleted too.",
			"confirm.action": "Delete permanently",
			cancel: "Cancel",
			close: "Close",
			done: "Done",
			pending: "Deleting\u2026",
			failed: "Delete failed: {message}",
			partial: "The session was removed, but some files could not be deleted yet (they may still be in use): {files}",
			memory: "The session was deleted, but its in-memory copy clears only after a Harness restart. It is kept hidden (archived) until then."
		};
		const zh = {
			"menu.deleteSession": "删除会话…",
			"confirm.title": "永久删除该会话？",
			"confirm.desc": "将永久删除「{title}」及其全部已存储的对话记录，此操作不可撤销。",
			"confirm.warning": "会话中正在运行的工作将先被停止；已归档的会话同样会被彻底删除。",
			"confirm.action": "永久删除",
			cancel: "取消",
			close: "关闭",
			done: "完成",
			pending: "正在删除…",
			failed: "删除失败：{message}",
			partial: "会话已删除，但部分文件暂未能清理（可能仍被占用）：{files}",
			memory: "会话已删除，但内存中的副本要到重启 Harness 后才会彻底消失；在此之前会保持隐藏（归档）。"
		};
		//#endregion

		//#region tiny observable store (getSnapshot/subscribe hook source)
		function createStore(initial) {
			let value = initial;
			const listeners = new Set();
			return {
				getSnapshot: () => value,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				set: (next) => {
					if (Object.is(next, value)) return;
					value = next;
					for (const listener of [...listeners]) listener();
				}
			};
		}
		//#endregion

		//#region components
		/** Menu row (order 500): raise the delete confirmation. */
		function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }) {
			const menuState = useMenuOpenState();
			const setMenuOpen = Array.isArray(menuState) ? menuState[1] : () => {};
			return h(
				MenuItemButton,
				{
					danger: true,
					separatorBefore: true,
					icon: h(TrashIcon, {}),
					onSelect: () => {
						setMenuOpen(false);
						requestDelete(sessionId, displayTitle);
					}
				},
				t("menu.deleteSession")
			);
		}

		/** The `shell.overlay` entry: nothing while no delete is requested. */
		function DeleteSessionDialog({ useDeleteRequest, settle, deleteSession, t }) {
			const request = useDeleteRequest((pending) => pending);
			if (request === null) return null;
			return h(DeleteConfirmForm, { key: request.sessionId, request, settle, deleteSession, t });
		}

		/** One request's dialog: in-flight and error state die with it. */
		function DeleteConfirmForm({ request, settle, deleteSession, t }) {
			const [busy, setBusy] = React.useState(false);
			const [error, setError] = React.useState(null);
			const [notes, setNotes] = React.useState(null);
			const controllerRef = React.useRef(null);
			React.useEffect(() => () => controllerRef.current?.abort(), []);
			const close = () => {
				if (!busy) settle();
			};
			const confirm = () => {
				setBusy(true);
				setError(null);
				const controller = new AbortController();
				controllerRef.current = controller;
				deleteSession(request.sessionId, controller.signal).then(
					(result) => {
						controllerRef.current = null;
						setBusy(false);
						const pending = [];
						if (result.filesRemaining.length > 0) pending.push(t("partial", { files: result.filesRemaining.join(", ") }));
						if (result.memoryResident) pending.push(t("memory"));
						if (pending.length > 0) setNotes(pending);
						else settle();
					},
					(reason) => {
						controllerRef.current = null;
						setBusy(false);
						setError(reason instanceof Error ? reason.message : String(reason));
					}
				);
			};
			return h(Modal, {
				open: true,
				onClose: close,
				title: t("confirm.title"),
				closeLabel: t("close"),
				description: t("confirm.desc", { title: request.displayTitle || request.sessionId }),
				footer: h(
					React.Fragment,
					null,
					h(Button, { variant: "outline", "data-modal-autofocus": "", disabled: busy, onClick: close }, t("cancel")),
					h(
						Button,
						{
							variant: "outline",
							className: "sd_dangerAction",
							disabled: busy,
							onClick: notes === null ? confirm : settle
						},
						notes === null ? t("confirm.action") : t("done")
					)
				),
				children: [
					h(
						"div",
						{ className: "sd_warning", key: "warning" },
						h("span", { className: "sd_warningIcon" }, h(WarningIcon, {})),
						h("p", null, t("confirm.warning"))
					),
					busy ? h("div", { className: "sd_status", role: "status", key: "busy" }, t("pending")) : null,
					error !== null
						? h("div", { className: "sd_error", role: "alert", key: "error" }, t("failed", { message: error }))
						: null,
					...(notes ?? []).map((note, index) =>
						h("div", { className: "sd_status", role: "status", key: `note-${String(index)}` }, note)
					)
				]
			});
		}
		//#endregion

		//#region mount
		const inject = ["remote", "slots", "locale"];

		async function apply(ctx) {
			ctx.effect(() => insertStyles(CSS), "session-delete styles");
			ctx.effect(() => ctx.locale.register(NS, { en, zh }), "session-delete dictionaries");

			const deleteRequest = createStore(null);
			const requestDelete = (sessionId, displayTitle) => {
				deleteRequest.set({ sessionId, displayTitle: displayTitle ?? "" });
			};
			const settle = () => {
				deleteRequest.set(null);
			};
			/** The session currently shown in the main conversation panel, if any. */
			const currentMainSessionId = () => {
				try {
					const list = ctx.get("sessions")?.list?.getSnapshot?.();
					return Object.values(list?.byId ?? {}).find((entry) => (entry?.retainedBy?.mainView ?? 0) > 0)?.id;
				} catch {
					return undefined;
				}
			};
			const deleteSession = async (sessionId, signal) => {
				let workspaceId;
				try {
					const snapshot = ctx.get("workspaces")?.list?.getSnapshot?.();
					workspaceId = (snapshot?.items ?? []).find((item) => (item.sessionIds ?? []).includes(sessionId))
						?.workspaceId;
				} catch {
					workspaceId = undefined;
				}
				// Leaving the deleted Session first releases the main-view retain so
				// the Host can quiesce its writer before the files are removed.
				if (currentMainSessionId() === sessionId) {
					try {
						ctx.get("uiWorkspace")?.startSession(workspaceId);
					} catch (reason) {
						console.warn("session-delete: navigating away before delete failed:", reason);
					}
				}
				// The mounted namespace is the Cordis service `remote.sessionDelete`;
				// property access would require it in `inject`, so read it through
				// `ctx.get()`, which is the inject-free lookup.
				const remote = ctx.get("remote.sessionDelete");
				if (remote === undefined || typeof remote.delete !== "function") {
					throw new Error("session-delete: the remote.sessionDelete namespace is not mounted");
				}
				const response = await remote.delete({ sessionId, stopActivity: true }, signal);
				if (!response.ok) throw response.error;
				const result = response.value;
				if (!result.ok) throw new Error(result.message ?? `session ${result.sessionId} was not found`);
				return result;
			};

			ctx.effect(
				() =>
					ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
						ctx.slots.register(
							{
								name: "sidebar.workspaces.session.menu.item",
								id: "delete",
								order: 500,
								locale: NS,
								inject: () => ({ requestDelete })
							},
							DeleteSessionMenuItem
						)
					),
				"session-delete menu item"
			);
			ctx.effect(
				() =>
					ctx.slots.inject("shell.overlay", () =>
						ctx.slots.register(
							{
								name: "shell.overlay",
								id: "session-delete-confirm",
								order: 40,
								locale: NS,
								inject: () => ({
									hooks: { deleteRequest },
									settle,
									deleteSession
								})
							},
							DeleteSessionDialog
						)
					),
				"session-delete confirm dialog"
			);

			const unmountRemote = await ctx.remote.$mount(TYPERT_REMOTE);
			ctx.effect(() => unmountRemote, "session-delete remote");
		}

		return { inject, apply };
		//#endregion
	}
});
