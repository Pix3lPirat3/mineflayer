module.exports = inject

// Shared item_stack_request helper for the Bedrock station plugins (trading, enchanting, anvil, grindstone, loom,
// smithing, ...). Bedrock moves items and drives block-UI operations with item_stack_request; every station follows the
// same shape (place inputs into the station's container slots, run a craft_* action, take the result out of the virtual
// creative_output slot 50). This centralises the request/response plumbing, the Java<->Bedrock slot mapping, and the
// authoritative-stack-id bookkeeping so each station plugin stays small and consistent. legacy_type_id below is the
// STABLE ItemStackRequestActionType enum the server reads (take=0, place=1, consume=5, craft_recipe=12, craft_creative=14,
// craft_recipe_optional=15, craft_grindstone=16, craft_loom=17, results_deprecated=19, beacon_payment=10) - using the
// wrong value makes the server read the action body with the wrong layout and silently drop the request.
function inject (bot) {
  if (!bot._stackRequest) bot._stackRequest = { id: 1 }
  const nextStackId = () => { bot._stackRequest.id -= 2; return bot._stackRequest.id }
  const send = (name, packet) => { if (typeof bot._client.queue === 'function') bot._client.queue(name, packet); else bot._client.write(name, packet) }
  const QUICK_BAR_START = 36
  const playerSlot = (bedrockSlot) => bedrockSlot < 9 ? QUICK_BAR_START + bedrockSlot : bedrockSlot
  const bedrockOf = (javaSlot) => javaSlot >= QUICK_BAR_START ? javaSlot - QUICK_BAR_START : javaSlot
  const invContainer = (bedrockSlot) => bedrockSlot < 9 ? 'hotbar' : 'inventory'
  const firstFreeBedrockSlot = () => { for (let s = 0; s < 36; s++) if (!bot.inventory.slots[playerSlot(s)]) return s; return null }
  const slotInfo = (bedrockSlot, stackId) => ({ slot_type: { container_id: invContainer(bedrockSlot) }, slot: bedrockSlot, stack_id: stackId ?? 0 })
  const stationSlot = (containerId, slot, stackId) => ({ slot_type: { container_id: containerId }, slot, stack_id: stackId ?? 0 })

  const pending = new Map()
  bot._client.on('item_stack_response', (packet) => {
    for (const response of packet.responses || []) {
      const p = pending.get(response.request_id)
      if (!p) continue
      pending.delete(response.request_id)
      p(response)
    }
  })

  // Send an item_stack_request. `actionsOrBuild` is either an actions array or a function(id) => actions (use the function
  // form when an action needs the request id, e.g. creative_output's stack id equals the request id). Resolves with
  // { id, response, status }; rejects if the server never answers.
  const stackReq = (actionsOrBuild, timeoutMs = 4000, customNames = []) => {
    const id = nextStackId()
    const actions = typeof actionsOrBuild === 'function' ? actionsOrBuild(id) : actionsOrBuild
    const done = new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error('item_stack_request: no item_stack_response from the server')) }, timeoutMs)
      pending.set(id, (response) => { clearTimeout(t); resolve(response) })
    })
    // custom_names carries anvil/loom text referenced by an action's filtered_string_index.
    send('item_stack_request', { requests: [{ request_id: id, actions, custom_names: customNames, cause: -1 }] })
    return done.then(response => ({ id, response, status: response.status }))
  }

  // The authoritative stack id the server assigned to a slot in `containerId` (from a response), for the follow-up
  // consume/take that must reference it.
  const stackIdFor = (response, containerId, slot) => {
    for (const c of response.containers || []) {
      if (c.slot_type?.container_id !== containerId) continue
      const s = (c.slots || []).find(x => x.slot === slot)
      if (s && s.item_stack_id != null) return s.item_stack_id
    }
    return 0
  }

  // Apply the server's authoritative stack ids/counts to the player inventory after a request (hotbar/inventory sides).
  const applyStackIds = (response) => {
    for (const c of response.containers || []) {
      const cid = c.slot_type?.container_id
      if (cid !== 'hotbar' && cid !== 'inventory') continue
      for (const s of c.slots || []) {
        const p = playerSlot(s.slot)
        const item = bot.inventory.slots[p]
        if (s.count === 0) { if (item) bot.inventory.updateSlot(p, null) } else if (item) { item.count = s.count; if (s.item_stack_id != null) item.stackId = s.item_stack_id }
      }
    }
  }

  // Open the player's own inventory screen if nothing is open (some station requests are processed against it); returns
  // a close() that closes it again if we opened it, so it does not shadow a later openContainer.
  const withInventoryOpen = async () => {
    if (bot.currentWindow || typeof bot.openInventory !== 'function') return () => {}
    bot.openInventory()
    await new Promise(r => setTimeout(r, 500))
    return () => { if (bot.currentWindow && typeof bot.closeWindow === 'function') { try { bot.closeWindow(bot.currentWindow) } catch {} } }
  }

  // Expose the shared toolkit. Station plugins read bot._stack.* rather than re-implementing this.
  bot._stack = { nextStackId, stackReq, stackIdFor, applyStackIds, playerSlot, bedrockOf, invContainer, firstFreeBedrockSlot, slotInfo, stationSlot, withInventoryOpen }
}
