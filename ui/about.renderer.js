// The one page with no state of its own: name, version, and the few places to
// go next. Links resolve to fixed URLs on the Rust side.
const LINKS = {
  aboutRepo: 'repo',
  aboutReleases: 'releases',
  aboutSupport: 'support',
};

for (const [id, target] of Object.entries(LINKS)) {
  document.getElementById(id).addEventListener('click', () => {
    window.api.openProjectLink(target).catch(() => {});
  });
}

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    window.api.closeAbout().catch(() => {});
  }
});

window.api
  .appInfo()
  .then((info) => {
    document.getElementById('aboutVersion').textContent =
      `Version ${info.version}`;
  })
  .catch(() => {
    // The page still stands without a version line.
  });
