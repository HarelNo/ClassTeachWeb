(() => {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

  document.querySelectorAll('[data-live-chat]').forEach((chat) => {
    const list = chat.querySelector('[data-chat-messages]');
    const form = chat.querySelector('[data-chat-form]');
    const input = form?.elements.namedItem('body');
    const sendButton = form?.querySelector('button[type="submit"]');
    const status = form?.querySelector('[data-chat-status]');
    if (!list || !form || !input || !sendButton || !status) return;

    let lastId = chat.dataset.nextId || '0';
    let stopped = chat.dataset.chatActive !== 'true';
    let requestInFlight = false;

    function appendMessage(message) {
      if ([...list.querySelectorAll('.chat-message')]
        .some((existing) => existing.dataset.messageId === String(message.id))) return;
      if (list.querySelector('[data-chat-empty]')) list.replaceChildren();
      const shouldScroll = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
      const article = document.createElement('article');
      article.className = 'chat-message';
      article.dataset.messageId = String(message.id);

      const heading = document.createElement('p');
      const author = document.createElement('strong');
      author.textContent = message.author_name;
      const time = document.createElement('time');
      const sentAt = new Date(message.created_at);
      time.dateTime = sentAt.toISOString();
      time.textContent = sentAt.toLocaleTimeString();
      heading.append(author, time);

      const body = document.createElement('p');
      body.textContent = message.body;
      article.append(heading, body);
      list.append(article);
      while (list.querySelectorAll('.chat-message').length > 100) {
        list.querySelector('.chat-message')?.remove();
      }
      lastId = String(message.id);
      chat.dataset.nextId = lastId;
      if (shouldScroll) list.scrollTop = list.scrollHeight;
    }

    function stopChat(message) {
      stopped = true;
      input.disabled = true;
      sendButton.disabled = true;
      status.textContent = message;
    }

    async function fetchMessages() {
      if (stopped || requestInFlight || document.visibilityState !== 'visible') return;
      requestInFlight = true;
      try {
        const url = new URL(chat.dataset.messagesUrl, window.location.origin);
        url.searchParams.set('after', lastId);
        const response = await fetch(url, { credentials: 'same-origin' });
        const result = await response.json().catch(() => ({}));
        if (response.status === 410) {
          stopChat(result.error || 'This class session has ended.');
          return;
        }
        if (!response.ok) throw new Error(result.error || 'Could not refresh class chat.');
        result.messages.forEach(appendMessage);
      } catch {
        status.textContent = 'Could not refresh chat. Retrying…';
      } finally {
        requestInFlight = false;
      }
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const body = input.value.trim();
      if (!body || stopped || !navigator.onLine) {
        status.textContent = stopped
          ? 'This class session has ended.'
          : !navigator.onLine ? 'Connect to the internet to send a live chat message.' : 'Enter a message first.';
        return;
      }
      sendButton.disabled = true;
      status.textContent = 'Sending…';
      try {
        const response = await fetch(chat.dataset.sendUrl, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body, csrfToken }),
        });
        const result = await response.json().catch(() => ({}));
        if (response.status === 410) {
          stopChat(result.error || 'This class session has ended.');
          return;
        }
        if (!response.ok) throw new Error(result.error || 'Could not send this message.');
        appendMessage(result.message);
        if (input.value.trim() === body) input.value = '';
        status.textContent = 'Message saved.';
      } catch (error) {
        status.textContent = error.message || 'Could not send this message.';
      } finally {
        sendButton.disabled = stopped;
      }
    });

    fetchMessages();
    window.setInterval(fetchMessages, 3000);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') fetchMessages();
    });
  });
})();
