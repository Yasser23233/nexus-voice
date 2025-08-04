// Populate the list of allowed user names and handle selection
document.addEventListener('DOMContentLoaded', () => {
  // Static list of permitted handles. Sorting here ensures a consistent
  // ordering each time the lobby is rendered. Feel free to rearrange
  // the array entries themselves for a different default order.
  const names = [
    'Ali',
    'Azzo',
    'Faisal Abdullah',
    'Faisal Sulaiman',
    'Mishari',
    'Moayad',
    'Noufi',
    'Yasser',
    'Ziyad'
  ].sort();

  const list = document.getElementById('name-list');

  // Build list items once and keep references so they can be updated
  names.forEach((name) => {
    const li = document.createElement('li');
    li.dataset.name = name;
    li.classList.add('name-entry');
    // Presence indicator element (a small dot)
    const indicator = document.createElement('span');
    indicator.className = 'presence-indicator';
    li.appendChild(indicator);
    // Text node for the name
    const text = document.createElement('span');
    text.className = 'name-text';
    text.textContent = name;
    li.appendChild(text);
    // Click handler to select this name if it's not currently online
    li.addEventListener('click', () => {
      if (li.classList.contains('online')) return;
      sessionStorage.setItem('username', name);
      // Unsubscribe from presence updates and close the socket before navigating
      socket.emit('unsubscribe-presence');
      socket.disconnect();
      window.location.href = 'room.html';
    });
    list.appendChild(li);
  });

  // Establish a Socket.IO connection to receive presence updates. This
  // connection is used only in the lobby; when a user selects a name the
  // connection will be closed.
  const socket = io();
  socket.emit('subscribe-presence');
  socket.on('presence', (activeNames) => {
    // Update the UI to reflect which names are currently online. When a
    // name is online we add the `online` class to disable selection and show
    // a green indicator.
    const entries = list.querySelectorAll('.name-entry');
    entries.forEach((li) => {
      if (activeNames.includes(li.dataset.name)) {
        li.classList.add('online');
      } else {
        li.classList.remove('online');
      }
    });
  });

  // Clean up the presence subscription when leaving the page (e.g. refresh)
  window.addEventListener('beforeunload', () => {
    socket.emit('unsubscribe-presence');
    socket.disconnect();
  });

  /**
   * Apply a flashing neon effect to the app title. This function
   * wraps each non‑space character of the .app-title element in a
   * span with the class neon-letter and assigns a random animation
   * delay to each letter. This gives the appearance of random
   * flickering similar to a neon sign. If executed multiple times
   * it will not duplicate spans. Call this after the DOM is ready.
   */
  function applyNeonEffect() {
    const title = document.querySelector('.app-title');
    if (!title || title.classList.contains('neon-applied')) return;
    const text = title.textContent;
    const fragments = [];
    for (const char of text) {
      if (char.trim() === '') {
        fragments.push(char);
      } else {
        const span = document.createElement('span');
        span.className = 'neon-letter';
        span.textContent = char;
        // Assign a random delay between 0 and 4 seconds
        const delay = (Math.random() * 4).toFixed(2);
        span.style.animationDelay = `-${delay}s`;
        fragments.push(span.outerHTML);
      }
    }
    title.innerHTML = fragments.join('');
    title.classList.add('neon-applied');
  }

  applyNeonEffect();
});