// Populate the list of allowed user names and handle selection
document.addEventListener('DOMContentLoaded', () => {
  // Static list of permitted handles; sorted alphabetically
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
  ];

  const list = document.getElementById('name-list');
  const nameItems = {};
  let lobbySocket;

  // Create list items for each available name
  names.sort().forEach((name) => {
    const li = document.createElement('li');
    li.dataset.name = name;
    li.textContent = name;
    li.addEventListener('click', () => {
      // If this name is already in use, do nothing
      if (li.classList.contains('online')) {
        alert('هذا الاسم مستخدم بالفعل حالياً. يرجى اختيار اسم آخر.');
        return;
      }
      sessionStorage.setItem('username', name);
      // Disconnect the lobby socket before navigating away
      if (lobbySocket && lobbySocket.connected) lobbySocket.disconnect();
      window.location.href = 'room.html';
    });
    nameItems[name] = li;
    list.appendChild(li);
  });

  // Connect to the server to receive live presence updates
  lobbySocket = io();
  lobbySocket.on('presence', (peerList) => {
    const activeNames = new Set(peerList.map((p) => p.name));
    Object.keys(nameItems).forEach((n) => {
      const li = nameItems[n];
      if (activeNames.has(n)) {
        li.classList.add('online');
      } else {
        li.classList.remove('online');
      }
    });
  });
});