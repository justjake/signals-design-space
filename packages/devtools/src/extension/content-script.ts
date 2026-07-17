/**
 * Content script (isolated world). Injects the page-world hook, then relays
 * between the page (window.postMessage) and the devtools panel
 * (chrome.runtime port). Pure pipe — no logic.
 */
import { CHANNEL, isDevtoolsMessage } from "./messages.ts"

// Inject the page-world script (web_accessible_resource).
const el = document.createElement("script")
el.src = chrome.runtime.getURL("inject.js")
el.onload = () => el.remove()
;(document.head || document.documentElement).appendChild(el)

const ports = new Set<chrome.runtime.Port>()

// Page → panel.
window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window || !isDevtoolsMessage(e.data)) return
  for (const port of ports) port.postMessage(e.data)
})

// Panel → page.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== CHANNEL) return
  ports.add(port)
  port.onDisconnect.addListener(() => ports.delete(port))
  port.onMessage.addListener((msg) => {
    if (isDevtoolsMessage(msg)) window.postMessage(msg, "*")
  })
})
