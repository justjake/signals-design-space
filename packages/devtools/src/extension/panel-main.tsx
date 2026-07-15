/**
 * Panel entry (devtools realm). Connects a port to the inspected page via the
 * content script, feeds each pushed snapshot into a SnapshotBackend, and
 * mounts the same panel App the inline host uses. The App can't tell it's over
 * a bridge — it just talks to a Backend.
 */
import { mountDevtools } from '../panel/mount.tsx'
import { CHANNEL, type DevtoolsMessage, isDevtoolsMessage } from './messages.ts'
import { SnapshotBackend } from './snapshot.ts'

const backend = new SnapshotBackend()

const tabId = chrome.devtools.inspectedWindow.tabId
const port = chrome.tabs.connect(tabId, { name: CHANNEL })

port.onMessage.addListener((msg: unknown) => {
	if (isDevtoolsMessage(msg) && msg.kind === 'snapshot') backend.update(msg.snapshot)
})

const request: DevtoolsMessage = { channel: CHANNEL, kind: 'request' }
port.postMessage(request)

const el = document.getElementById('root')
if (el !== null) mountDevtools(el, backend)
