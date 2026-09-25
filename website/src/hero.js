const heroes = ['mine-dusk', 'mine-day', 'mine-inside', 'mine-winter'];
document.documentElement.dataset.hero = heroes[Math.floor(Math.random() * heroes.length)];
