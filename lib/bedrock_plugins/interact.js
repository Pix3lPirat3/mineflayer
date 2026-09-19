const { Vec3 } = require('vec3')

module.exports = inject

// World-independent interactions: swing the arm, use the held item in the air, and attack or interact with an entity.
// Digging, placing and block activation need world block data (bot.blockAt, shapes) and live in the blocks-dependent
// plugins; they are intentionally not here. Bedrock is server-authoritative, so these send the client's intent and the
// server confirms via entity/health/inventory updates.
//
// Runtime vs unique ids: Bedrock packets that target an entity use its *runtime* entity id (a per-session varint64),
// not the persistent unique id. bot.entities is keyed by runtime id (entity.id); entity.uniqueId is the persistent id.
// The player's own runtime id is bot._client.entityId. Passing a unique id here is both wrong and can overflow the
// native varint writer, so every id below is resolved to the runtime id and coerced to BigInt.
function inject (bot) {
  const toBig = (v) => typeof v === 'bigint' ? v : BigInt(Math.trunc(Number(v)))
  const selfRuntimeId = () => bot._client.entityId ?? (bot.entity && bot.entity.id)
  const heldItem = () => (typeof bot.heldItem !== 'undefined' && bot.heldItem) ? bot.heldItem : null
  const toNetworkItem = (item) => {
    if (!item) return { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 }
    return { network_id: item.networkId ?? item.type, count: item.count ?? 1, metadata: item.metadata ?? 0, has_stack_id: false, block_runtime_id: 0 }
  }
  const send = (name, params) => { if (typeof bot._client.queue === 'function') bot._client.queue(name, params); else bot._client.write(name, params) }
  const pos = () => bot.entity ? { x: bot.entity.position.x, y: bot.entity.position.y + (bot.entity.eyeHeight || 1.62), z: bot.entity.position.z } : { x: 0, y: 0, z: 0 }

  bot.swingArm = (hand = 'right', showHand = true) => {
    if (!bot.entity) return
    send('animate', { action_id: 'swing_arm', runtime_entity_id: toBig(selfRuntimeId()), data: 0, has_swing_source: !!showHand, swing_source: 'attack' })
  }

  // Use the held item in the air (eat, drink, draw a bow, throw, ...). Bedrock: an item_use transaction with click_air.
  bot.activateItem = (offhand = false) => {
    const item = heldItem()
    send('inventory_transaction', {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: 'item_use',
        actions: [],
        transaction_data: {
          action_type: 'click_air',
          trigger_type: 'player_input',
          block_position: { x: 0, y: 0, z: 0 },
          face: 0xff,
          hotbar_slot: bot.quickBarSlot ?? 0,
          held_item: toNetworkItem(item),
          player_pos: pos(),
          click_pos: { x: 0, y: 0, z: 0 },
          block_runtime_id: 0,
          client_prediction: 'success',
          client_cooldown_state: 'off'
        }
      }
    })
    bot.swingArm('right', false)
  }

  bot.deactivateItem = () => {
    if (!bot.entity) return
    send('player_action', { runtime_entity_id: toBig(selfRuntimeId()), action: 'stop_item_use_on', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: 0 })
  }

  // Attack (or interact with) an entity: an item_use_on_entity transaction plus a swing, matching the real client.
  const entityTransaction = (entity, actionType) => {
    const target = typeof entity === 'object' ? entity : bot.entities[entity]
    if (!target) throw new Error('attack: unknown entity')
    const runtime = target.id ?? target.runtimeId
    if (runtime == null) throw new Error('attack: entity has no runtime id')
    send('inventory_transaction', {
      transaction: {
        legacy: { legacy_request_id: 0 },
        transaction_type: 'item_use_on_entity',
        actions: [],
        transaction_data: {
          entity_runtime_id: toBig(runtime),
          action_type: actionType,
          hotbar_slot: bot.quickBarSlot ?? 0,
          held_item: toNetworkItem(heldItem()),
          player_pos: pos(),
          click_pos: { x: 0, y: 0, z: 0 }
        }
      }
    })
  }

  bot.attack = (entity, swing = true) => {
    entityTransaction(entity, 'attack')
    if (swing) bot.swingArm('right')
  }

  bot.useOn = (entity) => {
    entityTransaction(entity, 'interact')
    bot.swingArm('right', false)
  }

  // Look helper reused from the entity/physics model when present, otherwise a no-op that keeps the API shape.
  if (typeof bot.lookAt !== 'function') {
    bot.lookAt = async (point) => {
      if (!bot.entity) return
      const delta = new Vec3(point.x, point.y, point.z).minus(bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0))
      bot.entity.yaw = Math.atan2(-delta.x, -delta.z)
      bot.entity.pitch = Math.atan2(delta.y, Math.sqrt(delta.x * delta.x + delta.z * delta.z))
    }
  }
}
