module.exports = inject

// Bedrock block-station UIs (anvil, enchanting table, grindstone, loom, smithing, ...). All open with container_open
// (bot.openContainer) and drive their operation with item_stack_request moves into station-specific container slots, then
// a station commit action, then take the result. Choreography verified against a real-client relay capture (1.26.51);
// see reviews/bedrock-in-mineflayer/STATIONS.md. Uses the shared bot._stack helper (stack_request.js).
function inject (bot) {
  const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))
  const Item = () => require('prismarine-item')(bot.registry)

  // Open a station block and wait for its window (returns the window or null). Confirms general openContainer works on any
  // station (grindstone/loom/smithing/brewing/beacon included). Best used with an empty hand so the click activates it.
  bot.openStation = async (block, ms = 3000) => {
    if (typeof bot.openContainer !== 'function') throw new Error('openStation needs the containers plugin')
    try { bot.openContainer(block) } catch {}
    const deadline = Date.now() + ms
    while (Date.now() < deadline) { if (bot.currentWindow) return bot.currentWindow; await wait(100) }
    return null
  }

  // Rename an item at an anvil. Verified capture: place the item into anvil_input[1], then one item_stack_request whose
  // request-level custom_names holds the new name and whose action is `optional` (craft_recipe_optional, legacy 15) with
  // filtered_string_index 0, consuming anvil_input[1] and taking the result from creative_output[50]. `anvilBlock` must be
  // an already-open anvil (call bot.openStation(anvilBlock) first) or a block to open.
  bot.anvilRename = async (anvilBlock, item, newName) => {
    if (!bot._stack) throw new Error('anvilRename: stack_request plugin not loaded')
    const { stackReq, stackIdFor, applyStackIds, bedrockOf, invContainer, firstFreeBedrockSlot } = bot._stack
    if (anvilBlock && anvilBlock.position) await bot.openStation(anvilBlock)
    const src = (typeof item === 'object' && item.name) ? item : bot.inventory.items().find(i => i.name === item || i.type === item)
    if (!src) throw new Error('anvilRename: item not found in inventory')

    // Place the item into the anvil input.
    const fromBedrock = bedrockOf(src.slot)
    const place = await stackReq([{ type_id: 'place', legacy_type_id: 1, count: src.count, source: { slot_type: { container_id: invContainer(fromBedrock) }, slot: fromBedrock, stack_id: src.stackId ?? 0 }, destination: { slot_type: { container_id: 'anvil_input' }, slot: 1, stack_id: 0 } }])
    if (place.status !== 'ok') throw new Error(`anvilRename: could not place the item (status ${place.status})`)
    const p = bot.inventory.slots[src.slot]; if (p) bot.inventory.updateSlot(src.slot, null)
    const inputStackId = stackIdFor(place.response, 'anvil_input', 1)
    await wait(120)

    const dest = firstFreeBedrockSlot()
    if (dest == null) throw new Error('anvilRename: no free inventory slot for the result')
    const { response, status } = await stackReq((rid) => [
      { type_id: 'optional', legacy_type_id: 15, recipe_network_id: 0, filtered_string_index: 0 },
      { type_id: 'consume', legacy_type_id: 5, count: src.count, source: { slot_type: { container_id: 'anvil_input' }, slot: 1, stack_id: inputStackId } },
      { type_id: 'take', legacy_type_id: 0, count: src.count, source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: rid }, destination: { slot_type: { container_id: invContainer(dest) }, slot: dest, stack_id: 0 } }
    ], 4000, [newName])
    if (status !== 'ok') throw new Error(`anvilRename: rejected (status ${status})`)
    const renamed = new (Item())(src.type, src.count, src.metadata ?? 0)
    renamed.customName = newName
    try { renamed.nbt = { type: 'compound', name: '', value: { display: { type: 'compound', value: { Name: { type: 'string', value: newName } } } } } } catch {}
    bot.inventory.updateSlot((dest < 9 ? 36 + dest : dest), renamed)
    applyStackIds(response)
    await wait(150)
    return renamed
  }

  // Combine two items at an anvil (item + item, e.g. tool + tool, or tool + enchanted_book), optionally renaming. Same
  // shape as rename but with a second item placed into anvil_material[2] and BOTH inputs consumed (the enchant fix taught
  // the lesson: a strict server rejects with status 18 unless every ingredient slot the recipe consumes is accounted for,
  // so consume anvil_material[2] too). The server computes the merged NBT; we read the result back from creative_output.
  // itemOne = the item kept (target), itemTwo = the sacrifice (consumed). newName is optional (empty = keep the name).
  bot.anvilCombine = async (anvilBlock, itemOne, itemTwo, newName = '') => {
    if (!bot._stack) throw new Error('anvilCombine: stack_request plugin not loaded')
    const { stackReq, stackIdFor, applyStackIds, bedrockOf, invContainer, firstFreeBedrockSlot } = bot._stack
    if (anvilBlock && anvilBlock.position) await bot.openStation(anvilBlock)
    const resolve = (it) => (typeof it === 'object' && it && it.name) ? it : bot.inventory.items().find(i => i.name === it || i.type === it)
    const one = resolve(itemOne); const two = resolve(itemTwo)
    if (!one) throw new Error('anvilCombine: itemOne not found in inventory')
    if (!two) throw new Error('anvilCombine: itemTwo not found in inventory')

    // Place the target into anvil_input[1] and the sacrifice into anvil_material[2].
    const oneBed = bedrockOf(one.slot)
    const p1 = await stackReq([{ type_id: 'place', legacy_type_id: 1, count: one.count, source: { slot_type: { container_id: invContainer(oneBed) }, slot: oneBed, stack_id: one.stackId ?? 0 }, destination: { slot_type: { container_id: 'anvil_input' }, slot: 1, stack_id: 0 } }])
    if (p1.status !== 'ok') throw new Error(`anvilCombine: could not place itemOne (status ${p1.status})`)
    bot.inventory.updateSlot(one.slot, null)
    const inputStackId = stackIdFor(p1.response, 'anvil_input', 1)
    await wait(120)
    const twoBed = bedrockOf(two.slot)
    const p2 = await stackReq([{ type_id: 'place', legacy_type_id: 1, count: two.count, source: { slot_type: { container_id: invContainer(twoBed) }, slot: twoBed, stack_id: two.stackId ?? 0 }, destination: { slot_type: { container_id: 'anvil_material' }, slot: 2, stack_id: 0 } }])
    if (p2.status !== 'ok') throw new Error(`anvilCombine: could not place itemTwo (status ${p2.status})`)
    bot.inventory.updateSlot(two.slot, null)
    const materialStackId = stackIdFor(p2.response, 'anvil_material', 2)
    await wait(120)

    const dest = firstFreeBedrockSlot()
    if (dest == null) throw new Error('anvilCombine: no free inventory slot for the result')
    const { response, status } = await stackReq((rid) => [
      { type_id: 'optional', legacy_type_id: 15, recipe_network_id: 0, filtered_string_index: 0 },
      { type_id: 'consume', legacy_type_id: 5, count: one.count, source: { slot_type: { container_id: 'anvil_input' }, slot: 1, stack_id: inputStackId } },
      { type_id: 'consume', legacy_type_id: 5, count: two.count, source: { slot_type: { container_id: 'anvil_material' }, slot: 2, stack_id: materialStackId } },
      { type_id: 'take', legacy_type_id: 0, count: one.count, source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: rid }, destination: { slot_type: { container_id: invContainer(dest) }, slot: dest, stack_id: 0 } }
    ], 4000, newName ? [newName] : [])
    if (status !== 'ok') throw new Error(`anvilCombine: rejected (status ${status})`)
    // The server merges enchants/repairs NBT; reflect a best-effort result item locally (the authoritative NBT is on the
    // server - callers that need the exact merged NBT should read the slot back via the containers plugin).
    const out = new (Item())(one.type, one.count, one.metadata ?? 0)
    if (newName) { out.customName = newName; try { out.nbt = { type: 'compound', name: '', value: { display: { type: 'compound', value: { Name: { type: 'string', value: newName } } } } } } catch {} }
    bot.inventory.updateSlot((dest < 9 ? 36 + dest : dest), out)
    applyStackIds(response)
    await wait(150)
    return out
  }

  // Enchanting. The server offers 3 options in player_enchant_options after an item + lapis are in the enchant slots; each
  // option carries an option_id and its enchant list (self_enchants = the set actually applied). Selecting one is an
  // item_stack_request craft_recipe whose recipe_network_id is the zigzag32-encoded option_id (e.g. option_id -2570 is sent
  // as 5139), a results_deprecated descriptor built from the option's self_enchants, a consume of the lapis the option
  // costs (exactly index+1 lapis, so the lapis slot is FULLY consumed - a strict server rejects a leftover with status 18),
  // a consume of enchanting_input[14], and a place of the result back into enchanting_input[14], which is then taken out.
  // Verified live against tower BDS 1.26.51 (choreography cross-checked with a real-client relay capture).
  bot.enchantmentOptions = []
  bot._client.on('player_enchant_options', (packet) => { bot.enchantmentOptions = packet.options || []; bot.emit('enchantmentOptionsReady', bot.enchantmentOptions) })
  const zigzag32 = (n) => ((n << 1) ^ (n >> 31)) >>> 0

  bot.enchant = async (tableBlock, item, choice = 0) => {
    if (!bot._stack) throw new Error('enchant: stack_request plugin not loaded')
    const { stackReq, stackIdFor, applyStackIds, bedrockOf, invContainer, firstFreeBedrockSlot } = bot._stack
    if (tableBlock && tableBlock.position) await bot.openStation(tableBlock)
    const src = (typeof item === 'object' && item.name) ? item : bot.inventory.items().find(i => i.name === item || i.type === item)
    if (!src) throw new Error('enchant: item not found in inventory')
    const lapis = bot.inventory.items().find(i => /lapis_lazuli|dye/.test(i.name || ''))
    if (!lapis) throw new Error('enchant: need lapis_lazuli in the inventory')

    // Clear any stale options and wait for the FRESH player_enchant_options the server sends after this item+lapis are
    // placed - using a stale option_id makes the craft recipe id wrong and the server rejects it (status 18).
    bot.enchantmentOptions = []
    const optionsReady = new Promise((resolve) => { const to = setTimeout(() => resolve(bot.enchantmentOptions || []), 4000); bot.once('enchantmentOptionsReady', (o) => { clearTimeout(to); resolve(o) }) })
    const itemBed = bedrockOf(src.slot)
    const itemStackId = src.stackId ?? 0
    const pi = await stackReq([{ type_id: 'place', legacy_type_id: 1, count: 1, source: { slot_type: { container_id: invContainer(itemBed) }, slot: itemBed, stack_id: itemStackId }, destination: { slot_type: { container_id: 'enchanting_input' }, slot: 14, stack_id: 0 } }])
    if (pi.status !== 'ok') throw new Error(`enchant: could not place the item (status ${pi.status})`)
    bot.inventory.updateSlot(src.slot, null)
    const inputStackId = stackIdFor(pi.response, 'enchanting_input', 14)
    // Bedrock enchant costs exactly (option index + 1) lapis for the top/middle/bottom option. Place EXACTLY that many so
    // the lapis slot can be fully consumed by the commit - placing the whole stack leaves a remainder and a strict server
    // (BDS) rejects the craft with status 18 (ExpectedItemSlotNotFullyConsumed). A lenient server auto-handles the leftover.
    const lapisBed = bedrockOf(lapis.slot)
    const lapisNeeded = Math.min(choice + 1, lapis.count)
    const pl = await stackReq([{ type_id: 'place', legacy_type_id: 1, count: lapisNeeded, source: { slot_type: { container_id: invContainer(lapisBed) }, slot: lapisBed, stack_id: lapis.stackId ?? 0 }, destination: { slot_type: { container_id: 'enchanting_lapis' }, slot: 15, stack_id: 0 } }]).catch(() => ({}))
    const lapisStackId = pl && pl.response ? stackIdFor(pl.response, 'enchanting_lapis', 15) : 0
    if (lapis.count > lapisNeeded) { lapis.count -= lapisNeeded; bot.inventory.updateSlot(lapis.slot, lapis) } else bot.inventory.updateSlot(lapis.slot, null)
    await wait(150)

    const options = await optionsReady
    const opt = options[choice] || options[0]
    if (!opt) throw new Error('enchant: no enchant options offered (needs enough levels/bookshelves)')
    // self_enchants is the set ACTUALLY applied to the item being enchanted (verified against a real-client capture:
    // the result ench id matched self_enchants, not held_enchants). held/equip are the "if held / if equipped" previews.
    const enchants = ((opt.self_enchants && opt.self_enchants.length ? opt.self_enchants : (opt.held_enchants && opt.held_enchants.length ? opt.held_enchants : opt.equip_enchants)) || []).filter(Boolean)
    const name = src.name.startsWith('minecraft:') ? src.name : 'minecraft:' + src.name
    const resultDescriptor = {
      type: 'name',
      legacy_type: 1,
      name,
      metadata: src.metadata ?? 0,
      count: 1,
      block_runtime_id: 0,
      extra: { has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { ench: { type: 'list', value: { type: 'compound', value: enchants.map(e => ({ id: { type: 'short', value: e.id }, lvl: { type: 'short', value: e.level } })) } } } } }, can_place_on: [], can_destroy: [] }
    }
    // Run the enchant: result lands back in enchanting_input[14].
    const craft = await stackReq((rid) => [
      { type_id: 'craft_recipe', legacy_type_id: 12, recipe_network_id: zigzag32(opt.option_id), times_crafted: 1 },
      { type_id: 'results_deprecated', legacy_type_id: 19, times_crafted: 1, result_items: [resultDescriptor] },
      // Consume the lapis the recipe costs (BDS validates the lapis slot is fully consumed - status 18 otherwise).
      ...(lapisStackId ? [{ type_id: 'consume', legacy_type_id: 5, count: lapisNeeded, source: { slot_type: { container_id: 'enchanting_lapis' }, slot: 15, stack_id: lapisStackId } }] : []),
      // The item keeps its own stack id when placed into enchanting_input (the capture consumes with the item's original
      // id), so prefer that over the place-response echo (which the server may not send for enchant slots).
      { type_id: 'consume', legacy_type_id: 5, count: 1, source: { slot_type: { container_id: 'enchanting_input' }, slot: 14, stack_id: itemStackId || inputStackId } },
      // The enchanted result is placed back into enchanting_input[14]; the capture uses the request id as BOTH the
      // creative_output source and the enchanting_input destination stack id (not 0), so match that.
      { type_id: 'place', legacy_type_id: 1, count: 1, source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: rid }, destination: { slot_type: { container_id: 'enchanting_input' }, slot: 14, stack_id: rid } }
    ])
    // NOTE: the descriptor is built from the option's self_enchants (the set the server applies). For single-hint options
    // this matches exactly; an option whose true outcome carries hidden extra enchants (rare, seed-derived) could still
    // mismatch. If that ever surfaces, the fix is to omit results_deprecated and read the enchants from the response.
    if (craft.status !== 'ok') throw new Error(`enchant: rejected (status ${craft.status})`)
    const resultStackId = stackIdFor(craft.response, 'enchanting_input', 14)
    // Take the enchanted item out into a free inventory slot.
    const dest = firstFreeBedrockSlot()
    if (dest == null) throw new Error('enchant: no free inventory slot for the result')
    const take = await stackReq([{ type_id: 'take', legacy_type_id: 0, count: 1, source: { slot_type: { container_id: 'enchanting_input' }, slot: 14, stack_id: resultStackId }, destination: { slot_type: { container_id: invContainer(dest) }, slot: dest, stack_id: 0 } }])
    if (take.status !== 'ok') throw new Error(`enchant: could not take the enchanted item (status ${take.status})`)
    const out = new (Item())(src.type, 1, src.metadata ?? 0)
    // prismarine-item's `set enchants` wants { name, lvl } (it resolves the numeric id from the name), so map the option's
    // numeric enchant ids back to names via the registry. Skip any id the registry does not know rather than crash.
    const byId = bot.registry.enchantmentsByName ? Object.values(bot.registry.enchantmentsByName) : []
    const named = enchants.map(e => { const m = byId.find(x => x.id === e.id); return m ? { name: m.name, lvl: e.level } : null }).filter(Boolean)
    try { if (named.length) out.enchants = named } catch {}
    bot.inventory.updateSlot((dest < 9 ? 36 + dest : dest), out)
    applyStackIds(take.response)
    await wait(150)
    return out
  }

  // Grindstone: remove all enchantments from an item (and reset its repair cost). Verified against a real-client capture:
  // place the item into grindstone_input[16], then one item_stack_request whose craft_grindstone_request carries
  // recipe_network_id = the PLACE request's id and cost 0, a results_deprecated descriptor of the disenchanted item (no
  // ench nbt; Damage kept, RepairCost 0), consuming grindstone_input[16] and taking the result from creative_output[50].
  bot.grindstone = async (block, item) => {
    if (!bot._stack) throw new Error('grindstone: stack_request plugin not loaded')
    const { stackReq, applyStackIds, bedrockOf, invContainer, firstFreeBedrockSlot } = bot._stack
    if (block && block.position) await bot.openStation(block)
    const src = (typeof item === 'object' && item.name) ? item : bot.inventory.items().find(i => i.name === item || i.type === item)
    if (!src) throw new Error('grindstone: item not found in inventory')

    const fromBed = bedrockOf(src.slot)
    const itemStackId = src.stackId ?? 0
    const place = await stackReq([{ type_id: 'place', legacy_type_id: 1, count: 1, source: { slot_type: { container_id: invContainer(fromBed) }, slot: fromBed, stack_id: itemStackId }, destination: { slot_type: { container_id: 'grindstone_input' }, slot: 16, stack_id: 0 } }])
    if (place.status !== 'ok') throw new Error(`grindstone: could not place the item (status ${place.status})`)
    bot.inventory.updateSlot(src.slot, null)
    await wait(120)

    // The disenchanted result: same item, all enchants removed, RepairCost reset to 0, current damage kept.
    const name = src.name.startsWith('minecraft:') ? src.name : 'minecraft:' + src.name
    const damage = src.durabilityUsed ?? (src.nbt?.value?.Damage?.value ?? 0)
    const resultDescriptor = {
      type: 'name',
      legacy_type: 1,
      name,
      metadata: src.metadata ?? 0,
      count: 1,
      block_runtime_id: 0,
      extra: { has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Damage: { type: 'int', value: damage }, RepairCost: { type: 'int', value: 0 } } } }, can_place_on: [], can_destroy: [] }
    }
    const dest = firstFreeBedrockSlot()
    if (dest == null) throw new Error('grindstone: no free inventory slot for the result')
    const { response, status } = await stackReq((rid) => [
      // recipe_network_id references the id of the place request that put the item into grindstone_input (capture-verified).
      { type_id: 'craft_grindstone_request', legacy_type_id: 16, recipe_network_id: place.id, times_crafted: 1, cost: 0 },
      { type_id: 'results_deprecated', legacy_type_id: 19, times_crafted: 1, result_items: [resultDescriptor] },
      { type_id: 'consume', legacy_type_id: 5, count: 1, source: { slot_type: { container_id: 'grindstone_input' }, slot: 16, stack_id: itemStackId } },
      { type_id: 'take', legacy_type_id: 0, count: 1, source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: rid }, destination: { slot_type: { container_id: invContainer(dest) }, slot: dest, stack_id: 0 } }
    ])
    if (status !== 'ok') throw new Error(`grindstone: rejected (status ${status})`)
    const out = new (Item())(src.type, 1, src.metadata ?? 0)
    bot.inventory.updateSlot((dest < 9 ? 36 + dest : dest), out)
    applyStackIds(response)
    await wait(150)
    return out
  }

  // Loom: apply a dyed pattern to a banner. Capture-derived (1.26.51): place banner->loom_input[9], dye->loom_dye[10],
  // then one item_stack_request: craft_loom_request{pattern, times_crafted}, results_deprecated{result banner with a
  // Patterns list [{Color:<dye colour int>, Pattern:<code>}] + Type}, consume loom_input[9], consume loom_dye[10], take
  // from creative_output[50]. `pattern` is the Bedrock loom pattern code (basic geometric ones like 'bo'/'bs' need no
  // item; 'cre'/'ss'/... need a banner-pattern item in loom_material[11]).
  // VERIFIED live (local BDS 1.26.45, 2026-09-22): the earlier "server silently drops the commit" was a stack-id bug -
  // the consume actions used the item's ORIGINAL inventory stack_id instead of the stack_id it got after being placed into
  // the loom slot (from the place response), so the server dropped the malformed request without a response. Fixed by
  // reading stackIdFor(place.response, ...) like anvil/grindstone. A basic pattern (bo/bs/...) needs only banner + dye; a
  // pattern that needs a banner-pattern item (cre/sku/flo/...) also places that item into loom_material[11] - not handled
  // here yet (pass a basic pattern, or place the material item via openContainer + raw moves).
  bot.loom = async (block, banner, dye, pattern = 'bo') => {
    if (!bot._stack) throw new Error('loom: stack_request plugin not loaded')
    const { stackReq, stackIdFor, applyStackIds, bedrockOf, invContainer, firstFreeBedrockSlot } = bot._stack
    if (block && block.position) await bot.openStation(block)
    const resolve = (it) => (typeof it === 'object' && it && it.name) ? it : bot.inventory.items().find(i => i.name === it || i.type === it)
    const b = resolve(banner); const d = resolve(dye)
    if (!b) throw new Error('loom: banner not found in inventory')
    if (!d) throw new Error('loom: dye not found in inventory')

    const bBed = bedrockOf(b.slot)
    const p1 = await stackReq([{ type_id: 'place', legacy_type_id: 1, count: 1, source: { slot_type: { container_id: invContainer(bBed) }, slot: bBed, stack_id: b.stackId ?? 0 }, destination: { slot_type: { container_id: 'loom_input' }, slot: 9, stack_id: 0 } }])
    if (p1.status !== 'ok') throw new Error(`loom: could not place the banner (status ${p1.status})`)
    bot.inventory.updateSlot(b.slot, null)
    const inputStackId = stackIdFor(p1.response, 'loom_input', 9)
    await wait(120)
    const dBed = bedrockOf(d.slot)
    const p2 = await stackReq([{ type_id: 'place', legacy_type_id: 1, count: d.count, source: { slot_type: { container_id: invContainer(dBed) }, slot: dBed, stack_id: d.stackId ?? 0 }, destination: { slot_type: { container_id: 'loom_dye' }, slot: 10, stack_id: 0 } }])
    if (p2.status !== 'ok') throw new Error(`loom: could not place the dye (status ${p2.status})`)
    if (d.count > 1) { d.count -= 1; bot.inventory.updateSlot(d.slot, d) } else bot.inventory.updateSlot(d.slot, null)
    const dyeStackId = stackIdFor(p2.response, 'loom_dye', 10)
    await wait(120)

    // The loom result carries a Patterns list (the applied pattern + the dye's banner colour) + a Type; the server drops
    // the request silently if this NBT is missing. Banner colour ints follow the dye order (white 0 .. red 14, black 15).
    const DYE_COLOR = { white_dye: 0, orange_dye: 1, magenta_dye: 2, light_blue_dye: 3, yellow_dye: 4, lime_dye: 5, pink_dye: 6, gray_dye: 7, light_gray_dye: 8, cyan_dye: 9, purple_dye: 10, blue_dye: 11, brown_dye: 12, green_dye: 13, red_dye: 14, black_dye: 15 }
    const color = DYE_COLOR[d.name] ?? 0
    const bannerName = b.name.startsWith('minecraft:') ? b.name : 'minecraft:' + b.name
    const resultDescriptor = {
      type: 'name',
      legacy_type: 1,
      name: bannerName,
      metadata: b.metadata ?? 0,
      count: 1,
      block_runtime_id: 0,
      extra: { has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Patterns: { type: 'list', value: { type: 'compound', value: [{ Color: { type: 'int', value: color }, Pattern: { type: 'string', value: pattern } }] } }, Type: { type: 'int', value: 0 } } } }, can_place_on: [], can_destroy: [] }
    }
    const dest = firstFreeBedrockSlot()
    if (dest == null) throw new Error('loom: no free inventory slot for the result')
    const { response, status } = await stackReq((rid) => [
      { type_id: 'craft_loom_request', legacy_type_id: 17, pattern, times_crafted: 1 },
      { type_id: 'results_deprecated', legacy_type_id: 19, times_crafted: 1, result_items: [resultDescriptor] },
      { type_id: 'consume', legacy_type_id: 5, count: 1, source: { slot_type: { container_id: 'loom_input' }, slot: 9, stack_id: inputStackId } },
      { type_id: 'consume', legacy_type_id: 5, count: 1, source: { slot_type: { container_id: 'loom_dye' }, slot: 10, stack_id: dyeStackId } },
      { type_id: 'take', legacy_type_id: 0, count: 1, source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: rid }, destination: { slot_type: { container_id: invContainer(dest) }, slot: dest, stack_id: 0 } }
    ])
    if (status !== 'ok') throw new Error(`loom: rejected (status ${status})`)
    const out = new (Item())(b.type, 1, b.metadata ?? 0)
    bot.inventory.updateSlot((dest < 9 ? 36 + dest : dest), out)
    applyStackIds(response)
    await wait(150)
    return out
  }

  // Brewing stand: time-based, NO craft action. Place fuel -> brewing_fuel[4], ingredient -> brewing_input[0], and up to
  // three bottles -> brewing_result[1..3]; the server brews over time (container_set_data carries the progress), and the
  // caller takes the bottles when done. VERIFIED live (local BDS 1.26.45, 2026-09-22): all placements accepted.
  bot.brew = async (block, { ingredient, fuel, bottles = [] } = {}) => {
    if (!bot._stack) throw new Error('brew: stack_request plugin not loaded')
    const { stackReq, bedrockOf, invContainer } = bot._stack
    if (block && block.position) await bot.openStation(block)
    const find = (it) => it && ((typeof it === 'object' && it.name) ? it : bot.inventory.items().find(i => i.name === it || i.type === it))
    const put = async (item, containerId, slot) => {
      const src = find(item); if (!src) return
      const bed = bedrockOf(src.slot)
      const r = await stackReq([{ type_id: 'place', legacy_type_id: 1, count: src.count, source: { slot_type: { container_id: invContainer(bed) }, slot: bed, stack_id: src.stackId ?? 0 }, destination: { slot_type: { container_id: containerId }, slot, stack_id: 0 } }])
      if (r.status === 'ok') bot.inventory.updateSlot(src.slot, null)
      await wait(120)
    }
    if (fuel) await put(fuel, 'brewing_fuel', 4)
    if (ingredient) await put(ingredient, 'brewing_input', 0)
    for (let i = 0; i < Math.min(bottles.length, 3); i++) await put(bottles[i], 'brewing_result', 1 + i)
    return true // brewing then proceeds server-side; poll container_set_data for progress and take when done
  }

  // Beacon: place an ingot -> beacon_payment[27], then one item_stack_request (beacon_payment{primary,secondary:0 when none}
  // > destroy with the placed stack_id, + cause). VERIFIED live (local BDS 1.26.45, status ok, haste applied). The earlier
  // status-2 rejections were entirely a TEST-SETUP artifact: the harness's /fill air dug a void the beacon/base fell into,
  // so the beacon was never on a valid powered pyramid. Built on SOLID ground (no air-digging) with a real 3x3 base + a
  // power-up wait (~12s so the tile-entity scans its base and the beam forms), the exact request works. primary/secondary
  // are Bedrock effect ids (1 speed, 3 haste). tools/bedrock-harness/beacon-watch.cjs is the non-destructive live check.
  bot.beaconActivate = async (block, primaryEffect, secondaryEffect = 0, payment) => {
    if (!bot._stack) throw new Error('beaconActivate: stack_request plugin not loaded')
    const { stackReq, stackIdFor, bedrockOf, invContainer } = bot._stack
    if (block && block.position) await bot.openStation(block)
    const pay = payment && (typeof payment === 'object' ? payment : bot.inventory.items().find(i => i.name === payment || i.type === payment))
    let payStackId = 0
    if (pay) {
      const bed = bedrockOf(pay.slot)
      const p = await stackReq([{ type_id: 'place', legacy_type_id: 1, count: 1, source: { slot_type: { container_id: invContainer(bed) }, slot: bed, stack_id: pay.stackId ?? 0 }, destination: { slot_type: { container_id: 'beacon_payment' }, slot: 27, stack_id: 0 } }])
      if (p.status === 'ok') { payStackId = stackIdFor(p.response, 'beacon_payment', 27); if (pay.count > 1) { pay.count -= 1; bot.inventory.updateSlot(pay.slot, pay) } else bot.inventory.updateSlot(pay.slot, null) }
      await wait(120)
    }
    // Matches the real-client capture (beacon_payment{primary,secondary:0 when none} > destroy the payment).
    const { status } = await stackReq([
      { type_id: 'beacon_payment', legacy_type_id: 10, primary_effect: primaryEffect, secondary_effect: secondaryEffect },
      { type_id: 'destroy', legacy_type_id: 4, count: 1, source: { slot_type: { container_id: 'beacon_payment' }, slot: 27, stack_id: payStackId } }
    ])
    if (status !== 'ok') throw new Error(`beaconActivate: rejected (status ${status})`)
    return true
  }
  // Smithing table (netherite upgrade): place base -> smithing_table_input[51], addition -> smithing_table_material[52],
  // template -> smithing_table_template[53], then craft_recipe{recipe_network_id} + results_deprecated + consume x3 (template,
  // input, material) + take. Capture-matched (1.26.51). The recipe_network_id is looked up at runtime from crafting_data's
  // smithing_transform_recipes (bot.smithingRecipes), matched by base + addition + template names.
  bot.smithing = async (block, base, addition = 'netherite_ingot', template = 'netherite_upgrade_smithing_template') => {
    if (!bot._stack) throw new Error('smithing: stack_request plugin not loaded')
    const { stackReq, stackIdFor, applyStackIds, bedrockOf, invContainer, firstFreeBedrockSlot } = bot._stack
    if (block && block.position) await bot.openStation(block)
    const resolve = (it) => (typeof it === 'object' && it && it.name) ? it : bot.inventory.items().find(i => i.name === it || i.type === it)
    const b = resolve(base); const add = resolve(addition); const tmpl = resolve(template)
    if (!b) throw new Error('smithing: base item not found in inventory')
    if (!add) throw new Error('smithing: addition (' + addition + ') not found in inventory')
    if (!tmpl) throw new Error('smithing: template (' + template + ') not found in inventory')
    const nm = (x) => ((x && x.name) || '').replace(/^minecraft:/, '')
    const recipe = (bot.smithingRecipes || []).find(r => nm(r.base) === b.name && nm(r.addition) === add.name && nm(r.template) === tmpl.name)
    if (!recipe || recipe.network_id == null) throw new Error('smithing: no crafting_data recipe for ' + b.name + ' + ' + add.name + ' (+' + tmpl.name + ')')
    const resultName = recipe.recipe_id.replace(/^minecraft:smithing_/, 'minecraft:')
    const place = async (item, containerId, slot) => {
      const bed = bedrockOf(item.slot)
      const rr = await stackReq([{ type_id: 'place', legacy_type_id: 1, count: 1, source: { slot_type: { container_id: invContainer(bed) }, slot: bed, stack_id: item.stackId ?? 0 }, destination: { slot_type: { container_id: containerId }, slot, stack_id: 0 } }])
      if (rr.status !== 'ok') throw new Error('smithing: could not place ' + item.name + ' (status ' + rr.status + ')')
      if (item.count > 1) { item.count -= 1; bot.inventory.updateSlot(item.slot, item) } else bot.inventory.updateSlot(item.slot, null)
      await wait(120)
      return stackIdFor(rr.response, containerId, slot)
    }
    const inputStackId = await place(b, 'smithing_table_input', 51)
    const materialStackId = await place(add, 'smithing_table_material', 52)
    const templateStackId = await place(tmpl, 'smithing_table_template', 53)
    const dest = firstFreeBedrockSlot()
    if (dest == null) throw new Error('smithing: no free inventory slot for the result')
    const resultDescriptor = { type: 'name', legacy_type: 1, name: resultName, metadata: 0, count: 1, block_runtime_id: 0, extra: { has_nbt: true, nbt: { version: 1, nbt: { type: 'compound', name: '', value: { Damage: { type: 'int', value: 0 }, RepairCost: { type: 'int', value: 0 } } } }, can_place_on: [], can_destroy: [] } }
    const { response, status } = await stackReq((rid) => [
      { type_id: 'craft_recipe', legacy_type_id: 12, recipe_network_id: recipe.network_id, times_crafted: 1 },
      { type_id: 'results_deprecated', legacy_type_id: 19, times_crafted: 1, result_items: [resultDescriptor] },
      { type_id: 'consume', legacy_type_id: 5, count: 1, source: { slot_type: { container_id: 'smithing_table_template' }, slot: 53, stack_id: templateStackId } },
      { type_id: 'consume', legacy_type_id: 5, count: 1, source: { slot_type: { container_id: 'smithing_table_input' }, slot: 51, stack_id: inputStackId } },
      { type_id: 'consume', legacy_type_id: 5, count: 1, source: { slot_type: { container_id: 'smithing_table_material' }, slot: 52, stack_id: materialStackId } },
      { type_id: 'take', legacy_type_id: 0, count: 1, source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: rid }, destination: { slot_type: { container_id: invContainer(dest) }, slot: dest, stack_id: 0 } }
    ])
    if (status !== 'ok') throw new Error('smithing: rejected (status ' + status + ')')
    const out = new (Item())(bot.registry.itemsByName[resultName.replace(/^minecraft:/, '')]?.id ?? b.type, 1, 0)
    bot.inventory.updateSlot((dest < 9 ? 36 + dest : dest), out)
    applyStackIds(response)
    await wait(150)
    return out
  }
}
