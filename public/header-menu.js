// The avatar menu, which is the one script a page without an item list still needs.
//
// It lives apart from app.js because the code pages are two forms and nothing else: they
// deliberately do not load the item list's script, and the menu used to be inside that
// script, so on those pages clicking the avatar did nothing at all.
//
// A profile picture can also stop loading (a revoked URL, an offline provider). Dropping
// the image leaves the initials underneath rather than a broken-image marker.

const accountMenuButton = document.getElementById('accountMenuButton');
const accountMenuPanel = document.getElementById('accountMenuPanel');

if (accountMenuButton && accountMenuPanel) {
  // "Add or remove ESO accounts" opens the dialog app.js draws over the item list. A page
  // without the item list has no dialog to open, so the item is taken out rather than left
  // there as a button that does nothing.
  if (!document.getElementById('accountsModal')) {
    const opener = accountMenuPanel.querySelector('[data-open-accounts]');

    if (opener) {
      opener.remove();
    }
  }

  const setMenuOpen = (open) => {
    accountMenuPanel.hidden = !open;
    accountMenuButton.setAttribute('aria-expanded', String(open));

    if (open) {
      const firstItem = accountMenuPanel.querySelector('button, a');
      if (firstItem) {
        firstItem.focus();
      }
    }
  };

  accountMenuButton.addEventListener('click', (event) => {
    event.stopPropagation();
    setMenuOpen(accountMenuPanel.hidden);
  });

  document.addEventListener('click', (event) => {
    if (!accountMenuPanel.hidden && !accountMenuPanel.contains(event.target)) {
      setMenuOpen(false);
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !accountMenuPanel.hidden) {
      setMenuOpen(false);
      accountMenuButton.focus();
    }
  });
}

document.querySelectorAll('.avatar-photo').forEach((photo) => {
  photo.addEventListener('error', () => photo.remove());
});
