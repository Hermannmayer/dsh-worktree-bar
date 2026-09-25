/**
 * A tiny React + DOM stand-in, enough to render this plugin's Client half in
 * plain Node. The deployment ships no React or jsdom for plugins to test
 * against, and the browser is not scriptable from a Host tool, so this harness
 * is what turns "the slot registered" into "the bar renders and its controls
 * call the right endpoints".
 *
 * Deliberately small: function components only, no keys/reconciliation (a
 * render rebuilds the whole tree), `useState`/`useEffect`/`useRef`/`useCallback`
 * with dependency skipping. Event handlers are invoked directly on the tree.
 */

/** Create one React-shaped object. */
export function createReact() {
  const FRAGMENT = Symbol('Fragment')

  let slots = []
  let index = 0
  let dirty = false
  let scheduled = false
  let tree = null
  let root = null
  let onDirty = () => {}

  function schedule() {
    dirty = true
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      onDirty()
    })
  }

  const React = {
    Fragment: FRAGMENT,
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter(child => child !== null && child !== undefined && child !== false) }
    },
    useState(initial) {
      const i = index
      index += 1
      if (slots[i] === undefined) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      return [slot.value, (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        schedule()
      }]
    },
    useEffect(effect, deps) {
      const i = index
      index += 1
      const slot = slots[i] ?? (slots[i] = {})
      const previous = slot.deps
      const changed = deps === undefined || previous === undefined
        || deps.length !== previous.length
        || deps.some((dep, k) => !Object.is(dep, previous[k]))
      slot.deps = deps
      return { slot, effect, changed }
    },
    useRef(initial) {
      const i = index
      index += 1
      if (slots[i] === undefined) slots[i] = { current: initial }
      return slots[i]
    },
    useCallback(fn, deps) {
      const i = index
      index += 1
      const slot = slots[i] ?? (slots[i] = {})
      const previous = slot.deps
      const changed = deps === undefined || previous === undefined
        || deps.length !== previous.length
        || deps.some((dep, k) => !Object.is(dep, previous[k]))
      slot.deps = deps
      if (changed || slot.value === undefined) slot.value = fn
      return slot.value
    },
  }

  function instantiate(element) {
    if (element === null || element === undefined || typeof element !== 'object') return element
    if (element.type === FRAGMENT) return element.children.map(instantiate).flat().filter(node => node !== null && node !== undefined)
    if (typeof element.type === 'function') {
      const returned = element.type({ ...element.props, children: element.children })
      return instantiate(returned)
    }
    const node = { type: element.type, props: element.props, children: element.children.map(instantiate).flat().filter(child => child !== null && child !== undefined) }
    if (element.props.ref !== undefined && element.props.ref !== null) element.props.ref.current = { contains: () => true, node }
    return node
  }

  function render() {
    index = 0
    dirty = false
    const pending = []
    // `useEffect` returns its own pending record through the component return
    // chain, which a function component cannot carry; effects are therefore
    // collected by a collector the hooks push into.
    collect = (record) => { pending.push(record) }
    tree = instantiate(root)
    collect = null
    for (const { slot, effect, changed } of pending) {
      if (!changed) continue
      if (typeof slot.cleanup === 'function') {
        try {
          slot.cleanup()
        } catch {
          // A cleanup failure must not hide the assertion that follows.
        }
      }
      slot.cleanup = undefined
      const cleanup = effect()
      if (typeof cleanup === 'function') slot.cleanup = cleanup
    }
    return tree
  }

  let collect = null

  const originalUseEffect = React.useEffect

  return {
    React,
    /**
     * Mount one element and settle every asynchronous state update it starts.
     * @param {{type: any, props: object, children: any[]}} element - the root element.
     * @returns {Promise<object>} the settled host tree.
     */
    async mount(element) {
      root = element
      slots = []
      // Route every effect into the current render's collector.
      React.useEffect = (effect, deps) => {
        const record = originalUseEffect.call(React, effect, deps)
        if (collect !== null) collect(record)
        return record
      }
      render()
      return this.settle()
    },
    /** Re-render while state keeps changing, letting pending promises resolve. */
    async settle(rounds = 25) {
      for (let round = 0; round < rounds; round += 1) {
        await new Promise(resolve => setTimeout(resolve, 0))
        if (dirty) render()
        else if (round > 2) break
      }
      return tree
    },
    /** The last rendered tree. */
    get tree() {
      return tree
    },
    /** Unmount, running every effect cleanup. */
    unmount() {
      for (const slot of slots) {
        if (typeof slot?.cleanup === 'function') slot.cleanup()
      }
      slots = []
      tree = null
    },
    set onDirty(handler) {
      onDirty = handler
    },
  }
}

/**
 * Collect every node in a rendered tree that matches a predicate.
 * @param {any} node - a rendered node.
 * @param {(node: object) => boolean} predicate - the matcher.
 * @returns {object[]} matching nodes in document order.
 */
export function findAll(node, predicate) {
  const found = []
  const walk = (current) => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    if (predicate(current)) found.push(current)
    for (const child of current.children ?? []) walk(child)
  }
  walk(node)
  return found
}

/** Every text leaf under a node, joined. */
export function textOf(node) {
  const parts = []
  const walk = (current) => {
    if (current === null || current === undefined) return
    if (typeof current === 'string' || typeof current === 'number') {
      parts.push(String(current))
      return
    }
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    for (const child of current.children ?? []) walk(child)
  }
  walk(node)
  return parts.join('')
}

/**
 * Install the browser globals the Client half touches, and record what it did.
 * @returns {{ calls: object[], intervals: object[], clipboard: string[], restore: () => void }} the recorder and its undo.
 */
export function installDom() {
  const calls = []
  const intervals = []
  const clipboard = []
  const listeners = new Map()
  const head = []

  const documentStub = {
    visibilityState: 'visible',
    head: {
      appendChild(node) {
        head.push(node)
      },
    },
    createElement(tag) {
      return { tag, dataset: {}, textContent: '', style: {}, setAttribute() {}, remove() {}, appendChild() {}, select() {} }
    },
    body: { appendChild() {} },
    querySelector: () => null,
    execCommand: () => true,
    addEventListener(type, handler) {
      listeners.set(`document:${type}`, handler)
    },
    removeEventListener(type) {
      listeners.delete(`document:${type}`)
    },
  }

  const windowStub = {
    addEventListener(type, handler) {
      listeners.set(`window:${type}`, handler)
    },
    removeEventListener(type) {
      listeners.delete(`window:${type}`)
    },
    __ModuleLoader__: { load() {} },
  }

  const previous = new Map()
  /** Override one global, remembering how to put it back. */
  const define = (name, value) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: false })
  }

  // `navigator` is a getter-only property on modern Node, so every override
  // goes through a property definition rather than an assignment.
  define('window', windowStub)
  define('document', documentStub)
  define('navigator', { clipboard: { writeText: async (text) => { clipboard.push(text) } } })
  define('fetch', async (url, init) => {
    calls.push({ url, body: JSON.parse(init?.body ?? '{}') })
    const value = respond(url, calls[calls.length - 1].body)
    return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
  })
  define('setInterval', (handler, ms) => {
    intervals.push({ handler, ms })
    return intervals.length
  })
  define('clearInterval', () => {})

  return {
    calls,
    intervals,
    clipboard,
    head,
    listeners,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor === undefined) delete globalThis[name]
        else Object.defineProperty(globalThis, name, descriptor)
      }
    },
  }
}

/** Default route responses; a test may override `respond` by assignment. */
export let respond = () => ({})

/** Replace the route responder. */
export function setResponder(handler) {
  respond = handler
}
