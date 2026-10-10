/** @jsxImportSource @opentui/solid */
// `lanes` terminal side (OpenCode V2 CLI plugin): a Lanes tab in the session
// composer, the panel the Down key opens beside Subagents and Shell, built
// like the Subagents tab. It lists each lanes run in this session tree (its
// planner) with the run's tasks, including ones not started yet, from the
// summary the server keeps on the planner session (see view.ts). The tab needs
// the `session.composer.tab` slot that OpenCode gets from
// nixos-config/patches/opencode-composer-plugin-tabs.diff; without it the
// claim has no target and nothing is shown.
import type { RGBA, ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { type Row, readView, rows, VIEW_KEY, type View } from "./view"

const TAB = "lanes"

interface ComposerTabInput {
	readonly sessionID: string
	register(tab: { id: string; label: string; hints?: () => { label: string; shortcut: string }[] }): () => void
	active(id: string): boolean
	close(): void
}

interface SessionInfo {
	readonly agent?: string
	readonly metadata?: Readonly<Record<string, unknown>>
}

interface StatefulColor {
	readonly base: RGBA
	readonly selected: RGBA
	readonly focused: RGBA
}

interface KeymapLayer {
	mode: string
	enabled: () => boolean
	priority: number
	commands: { title: string; group: string; bind: string; run(): void }[]
}

interface TuiContext {
	readonly theme: {
		readonly text: { readonly muted: RGBA; readonly action: { readonly primary: StatefulColor } }
		readonly background: { readonly action: { readonly primary: StatefulColor } }
	}
	readonly client: {
		session: {
			get(input: { sessionID: string }): Promise<SessionInfo>
			interrupt(input: { sessionID: string }): Promise<unknown>
		}
	}
	readonly data: {
		on(
			type: "session.metadata.updated",
			handler: (event: { data: { sessionID: string; metadata?: Readonly<Record<string, unknown>> } }) => void,
		): () => void
		readonly session: {
			get(sessionID: string): SessionInfo | undefined
			family(sessionID: string): string[]
		}
	}
	readonly keymap: { layer(factory: () => KeymapLayer): void }
	readonly ui: {
		slot(claim: { append: "session.composer.tab"; render: (input: ComposerTabInput) => JSX.Element }): () => void
		router: { navigate(destination: { type: "session"; sessionID: string }): void }
		toast: { show(input: { message: string; variant?: "info" | "success" | "warning" | "error" }): void }
	}
}

interface TabProps {
	context: TuiContext
	input: ComposerTabInput
	views: Readonly<Record<string, View>>
	fetch(sessionID: string): void
}

// The scrollbox finishes layout on the next frame, so centering waits for it.
const nextFrame = (callback: () => void) => {
	const raf = (globalThis as { requestAnimationFrame?: (callback: () => void) => unknown }).requestAnimationFrame
	if (raf) raf(callback)
	else setTimeout(callback, 16)
}

function LanesTab(props: TabProps) {
	const theme = () => props.context.theme
	const [store, setStore] = createStore({ selected: 0 })
	const [active, setActive] = createSignal(true)
	let scroll: ScrollBoxRenderable | undefined

	const shown = () => props.input.active(TAB)
	const family = createMemo(() => props.context.data.session.family(props.input.sessionID))

	// Planner sessions loaded before their first summary event arrived are read once.
	createEffect(() => {
		for (const id of family()) {
			if (!props.views[id] && props.context.data.session.get(id)?.agent === "planner") props.fetch(id)
		}
	})

	const list = createMemo(() =>
		rows(
			family().flatMap((planner) => {
				const view = props.views[planner]
				return view ? [{ planner, view }] : []
			}),
			active(),
			props.input.sessionID,
		),
	)
	const selected = createMemo<Row | undefined>(() => list()[store.selected])

	function scrollToIndex(index: number, center: boolean) {
		if (!scroll) return
		if (center) {
			scroll.scrollTo(Math.max(0, index - Math.floor(scroll.viewport.height / 2)))
			return
		}
		if (index >= scroll.scrollTop + scroll.viewport.height) scroll.scrollTo(index - scroll.viewport.height + 1)
		if (index < scroll.scrollTop) scroll.scrollTo(index)
	}

	function moveTo(index: number, center = false) {
		setStore("selected", index)
		scrollToIndex(index, center)
	}

	// On opening, select the row of the session being viewed, like the Subagents tab.
	let selectedFor = ""
	let wasShown = false
	createEffect(() => {
		if (!shown()) {
			if (wasShown) {
				selectedFor = ""
				setStore("selected", 0)
			}
			wasShown = false
			return
		}
		const current = list()
		if (selectedFor !== props.input.sessionID && current.length > 0) {
			const index = Math.max(
				0,
				current.findIndex((row) => row.current),
			)
			selectedFor = props.input.sessionID
			setStore("selected", index)
			scrollToIndex(index, true)
			nextFrame(() => scrollToIndex(index, true))
		}
		wasShown = true
		if (store.selected >= current.length) moveTo(Math.max(0, current.length - 1))
	})

	function open(row: Row | undefined) {
		if (!row) return
		if (!row.sessionID) {
			props.context.ui.toast.show({ message: `${row.label.split(": ").at(-1)} has not started yet.`, variant: "info" })
			return
		}
		props.context.ui.router.navigate({ type: "session", sessionID: row.sessionID })
	}

	function interrupt(row: Row | undefined) {
		if (!row?.running || !row.sessionID) return
		void props.context.client.session.interrupt({ sessionID: row.sessionID })
	}

	onMount(() => {
		const remove = props.input.register({
			id: TAB,
			label: "Lanes",
			hints: () => [
				...(selected()?.running ? [{ label: "interrupt", shortcut: "ctrl+d" }] : []),
				{ label: `show ${active() ? "finished" : "active"}`, shortcut: "ctrl+a" },
			],
		})
		onCleanup(remove)
	})

	props.context.keymap.layer(() => ({
		mode: "composer",
		enabled: shown,
		priority: 1,
		commands: [
			{
				title: "Previous lane",
				group: "Composer",
				bind: "up",
				run() {
					if (store.selected === 0) props.input.close()
					else moveTo(store.selected - 1, true)
				},
			},
			{
				title: "Next lane",
				group: "Composer",
				bind: "down",
				run() {
					const count = list().length
					if (count > 0) moveTo((store.selected + 1) % count, true)
				},
			},
			{ title: "Open lane session", group: "Composer", bind: "return", run: () => open(selected()) },
			{ title: "Interrupt lane", group: "Composer", bind: "ctrl+d", run: () => interrupt(selected()) },
			{
				title: "Toggle finished lanes runs",
				group: "Composer",
				bind: "ctrl+a",
				run() {
					setActive((value) => !value)
					setStore("selected", 0)
					scroll?.scrollTo(0)
				},
			},
		],
	}))

	return (
		<Show when={shown()}>
			<scrollbox
				scrollbarOptions={{ visible: false }}
				maxHeight={5}
				ref={(element: ScrollBoxRenderable) => {
					scroll = element
				}}
			>
				<Show
					when={list().length > 0}
					fallback={<text fg={theme().text.muted}> No {active() ? "active" : "finished"} lanes runs</text>}
				>
					<For each={list()}>
						{(row, index) => {
							const focused = createMemo(() => index() === store.selected)
							const color = (variant: StatefulColor) =>
								focused() ? variant.focused : row.current ? variant.selected : variant.base
							return (
								<box
									flexDirection="row"
									paddingLeft={1}
									paddingRight={1}
									backgroundColor={color(theme().background.action.primary)}
									onMouseMove={() => setStore("selected", index())}
									onMouseUp={() => {
										setStore("selected", index())
										open(row)
									}}
								>
									<box flexGrow={1} minWidth={0} flexDirection="row">
										<text fg={color(theme().text.action.primary)} wrapMode="none">
											{row.prefix}
											<Show when={focused()} fallback={row.label}>
												<b>{row.label}</b>
											</Show>
										</text>
									</box>
									<text fg={focused() ? theme().text.action.primary.focused : theme().text.muted} wrapMode="none">
										{row.status}
									</text>
								</box>
							)
						}}
					</For>
				</Show>
			</scrollbox>
		</Show>
	)
}

export default {
	id: "lanes",
	setup(context: TuiContext) {
		const [views, setViews] = createStore<Record<string, View>>({})
		const fetched = new Set<string>()
		const fetch = (sessionID: string) => {
			if (fetched.has(sessionID)) return
			fetched.add(sessionID)
			context.client.session.get({ sessionID }).then(
				(info) => {
					const view = readView(info.metadata?.[VIEW_KEY])
					if (view) setViews(sessionID, view)
				},
				() => fetched.delete(sessionID),
			)
		}
		const off = context.data.on("session.metadata.updated", (event) => {
			const view = readView(event.data.metadata?.[VIEW_KEY])
			if (view) setViews(event.data.sessionID, view)
		})
		const release = context.ui.slot({
			append: "session.composer.tab",
			render: (input) => <LanesTab context={context} input={input} views={views} fetch={fetch} />,
		})
		return () => {
			off()
			release()
		}
	},
}
