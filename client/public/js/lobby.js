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
  names.sort().forEach((name) => {
    const li = document.createElement('li');
    li.textContent = name;
    li.dataset.name = name;
    li.addEventListener('click', () => {
      // Persist the chosen name in sessionStorage so room.html can read it
      sessionStorage.setItem('username', name);
      window.location.href = 'room.html';
    });
    list.appendChild(li);
  });
});