module.exports = inject

// Bedrock server forms (modal_form_request/response). Many hub, lobby and minigame servers gate actions behind a form
// (a menu, a text prompt, a yes/no), and a bot that never answers just hangs. This surfaces each form as a 'modalForm'
// event and lets the bot reply with bot.answerForm / close it with bot.closeForm. Java has no equivalent (this is a
// Bedrock-only capability), so the API is additive.
function inject (bot) {
  const send = (name, packet) => { if (typeof bot._client.queue === 'function') bot._client.queue(name, packet); else bot._client.write(name, packet) }
  bot.forms = bot.forms || {}

  bot._client.on('modal_form_request', (packet) => {
    let form = packet.data
    try { form = JSON.parse(packet.data) } catch { /* keep the raw string if it is not JSON */ }
    bot.forms[packet.form_id] = form
    // form.type is 'form' (button list), 'modal' (two-button), or 'custom_form' (fields). Consumers inspect it and reply.
    bot.emit('modalForm', packet.form_id, form)
  })

  // Answer a form. `response` is JSON-encoded and its meaning depends on the form type: a button index (number) for a
  // 'form', a boolean for a 'modal', or an array of field values for a 'custom_form'. Pass undefined to send an empty
  // response (rarely wanted - prefer closeForm to decline).
  bot.answerForm = (formId, response) => {
    send('modal_form_response', {
      form_id: formId,
      has_response_data: response !== undefined,
      data: response !== undefined ? JSON.stringify(response) : undefined,
      has_cancel_reason: false
    })
    delete bot.forms[formId]
  }

  // Decline/close a form without answering (reason: 'closed' = the user closed it, 'busy' = the client was busy).
  bot.closeForm = (formId, reason = 'closed') => {
    send('modal_form_response', {
      form_id: formId,
      has_response_data: false,
      has_cancel_reason: true,
      cancel_reason: reason
    })
    delete bot.forms[formId]
  }
}
