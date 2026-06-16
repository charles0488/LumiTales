const elements = {
  shelfPanel: document.querySelector("#bookshelfPanel"),
  shelfToggle: document.querySelector("#bookshelfToggle"),
  shelfClose: document.querySelector("#bookshelfClose"),
  shelfScrim: document.querySelector("#bookshelfScrim"),
  shelf: document.querySelector("#bookShelf"),
  shelfCount: document.querySelector("#bookShelfCount"),
  title: document.querySelector("#bookTitle"),
  pageCount: document.querySelector("#pageCount"),
  imageFrame: document.querySelector(".image-frame"),
  image: document.querySelector("#pageImage"),
  audio: document.querySelector("#audioPlayer"),
  playbackPane: document.querySelector(".playback-pane"),
  previous: document.querySelector("#prevButton"),
  play: document.querySelector("#playButton"),
  next: document.querySelector("#nextButton"),
  edit: document.querySelector("#editButton"),
  editor: document.querySelector("#pageEditor"),
  autoAdvance: document.querySelector("#autoAdvance"),
  content: document.querySelector("#pageContent"),
  save: document.querySelector("#saveButton"),
  status: document.querySelector("#saveStatus")
};

let books = [];
let book;
let bookId;
let currentIndex = 0;
let isReading = false;
let isEditing = false;
let dirty = false;
let statusTimer;
let isShelfOpen = false;
let isPlaybackPaneVisible = true;

function assetPath(asset) {
  const rawPath = asset?.path?.replace(/^\.\//, "") || "";
  if (!rawPath) {
    return "";
  }

  if (rawPath.startsWith("books/")) {
    return `/${rawPath}`;
  }

  return `/books/${bookId}/${rawPath}`;
}

function audioPath(page) {
  const version = page.audioUpdatedAt ? `?v=${page.audioUpdatedAt}` : "";
  return `${assetPath(page.audio)}${version}`;
}

function currentPage() {
  return book.pages[currentIndex];
}

function setStatus(message) {
  window.clearTimeout(statusTimer);
  elements.status.textContent = message;
  if (message) {
    statusTimer = window.setTimeout(() => {
      elements.status.textContent = "";
    }, 2400);
  }
}

function setShelfOpen(nextIsOpen) {
  isShelfOpen = nextIsOpen;
  document.body.classList.toggle("is-shelf-open", isShelfOpen);
  elements.shelfToggle.setAttribute("aria-expanded", String(isShelfOpen));
  elements.shelfPanel.setAttribute("aria-hidden", String(!isShelfOpen));
  elements.shelfScrim.hidden = !isShelfOpen;

  if (isShelfOpen) {
    elements.shelfPanel.focus();
  }
}

function setPlaybackPaneVisible(nextIsVisible) {
  isPlaybackPaneVisible = nextIsVisible;
  document.body.classList.toggle("is-playback-pane-hidden", !isPlaybackPaneVisible);
  elements.playbackPane.setAttribute("aria-hidden", String(!isPlaybackPaneVisible));
}

function updateNavigation() {
  const hasBook = Boolean(book);
  elements.previous.disabled = !hasBook || currentIndex === 0;
  elements.next.disabled = !hasBook || currentIndex === book.pages.length - 1;
  elements.play.disabled = !hasBook;
  elements.edit.disabled = !hasBook;
  elements.save.disabled = !hasBook;
  if (!hasBook) {
    return;
  }

  elements.play.textContent = isReading ? "⏸" : "▶";
  elements.play.setAttribute("aria-label", isReading ? "Pause" : "Play");
  elements.edit.textContent = "✎";
  elements.edit.setAttribute("aria-label", isEditing ? "Close" : "Edit");
  elements.edit.setAttribute("aria-expanded", String(isEditing));
}

function setEditingMode(nextIsEditing) {
  isEditing = nextIsEditing;
  elements.editor.hidden = !isEditing;
  document.body.classList.toggle("is-editing", isEditing);
  updateNavigation();

  if (isEditing) {
    elements.content.focus();
    elements.content.select();
  }
}

function renderPage({ playAudio = isReading } = {}) {
  const page = currentPage();
  elements.title.textContent = book.title;
  elements.pageCount.textContent = `Page ${currentIndex + 1} of ${book.pages.length}`;
  elements.image.src = assetPath(page.image);
  elements.image.alt = `${book.title}, page ${page.page_number}`;
  elements.audio.src = audioPath(page);
  elements.content.value = page.content;
  dirty = false;
  setEditingMode(false);
  updateNavigation();

  if (playAudio) {
    playCurrentAudio();
  } else {
    elements.audio.pause();
    elements.audio.currentTime = 0;
  }
}

function renderShelf() {
  elements.shelfCount.textContent = `${books.length} ${books.length === 1 ? "book" : "books"}`;
  elements.shelf.replaceChildren(
    ...books.map((shelfBook) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "book-card";
      button.dataset.bookId = shelfBook.id;
      button.setAttribute("aria-pressed", String(shelfBook.id === bookId));

      const cover = document.createElement("img");
      cover.src = assetPathForBook(shelfBook.id, shelfBook.cover);
      cover.alt = "";
      cover.loading = "lazy";

      const title = document.createElement("span");
      title.className = "book-card-title";
      title.textContent = shelfBook.title;

      const meta = document.createElement("span");
      meta.className = "book-card-meta";
      meta.textContent = `${shelfBook.pageCount} pages`;

      button.append(cover, title, meta);
      button.addEventListener("click", () => {
        if (shelfBook.id !== bookId) {
          selectBook(shelfBook.id);
        }
        setShelfOpen(false);
      });

      return button;
    })
  );
}

function assetPathForBook(nextBookId, asset) {
  const rawPath = asset?.path?.replace(/^\.\//, "") || "";
  if (!rawPath) {
    return "";
  }

  if (rawPath.startsWith("books/")) {
    return `/${rawPath}`;
  }

  return `/books/${nextBookId}/${rawPath}`;
}

async function playCurrentAudio() {
  isReading = true;
  updateNavigation();

  try {
    elements.audio.currentTime = 0;
    await elements.audio.play();
    setPlaybackPaneVisible(false);
  } catch {
    isReading = false;
    setPlaybackPaneVisible(true);
    updateNavigation();
    setStatus("Press Play to start audio");
  }
}

function pauseAudio() {
  isReading = false;
  elements.audio.pause();
  setPlaybackPaneVisible(true);
  updateNavigation();
}

function goToPage(index, options = {}) {
  if (index < 0 || index >= book.pages.length) {
    return;
  }
  currentIndex = index;
  renderPage(options);
}

function goNext(options = {}) {
  goToPage(currentIndex + 1, options);
}

function goPrevious(options = {}) {
  goToPage(currentIndex - 1, options);
}

async function saveCurrentPage() {
  const page = currentPage();
  const content = elements.content.value.trim();
  elements.save.disabled = true;
  setStatus("Saving voice...");

  try {
    const response = await fetch(`/api/books/${bookId}/pages/${page.page_number}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content })
    });

    if (!response.ok) {
      throw new Error("Save failed.");
    }

    const result = await response.json();
    page.content = content;
    page.audio = result.page.audio;
    page.audioUpdatedAt = result.audioUpdatedAt;
    elements.audio.src = audioPath(page);
    dirty = false;
    setStatus("Saved");
    setEditingMode(false);
  } catch {
    setStatus("Could not save");
  } finally {
    elements.save.disabled = false;
  }
}

async function selectBook(nextBookId, { updateUrl = true } = {}) {
  pauseAudio();
  setEditingMode(false);
  bookId = nextBookId;
  book = null;
  currentIndex = 0;
  dirty = false;
  elements.title.textContent = "Loading...";
  elements.pageCount.textContent = "";
  elements.image.removeAttribute("src");
  elements.image.alt = "";
  elements.content.value = "";
  updateNavigation();
  renderShelf();

  try {
    const response = await fetch(`/api/books/${bookId}`);
    if (!response.ok) {
      throw new Error("Book not found.");
    }
    book = await response.json();
    book.pages.sort((a, b) => a.page_number - b.page_number);
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("book", bookId);
      window.history.replaceState({}, "", url);
    }
    renderPage({ playAudio: false });
    renderShelf();
  } catch {
    elements.title.textContent = "Could not load book";
    elements.pageCount.textContent = "";
    elements.save.disabled = true;
    elements.play.disabled = true;
    elements.previous.disabled = true;
    elements.next.disabled = true;
    elements.edit.disabled = true;
  }
}

elements.previous.addEventListener("click", () => {
  goPrevious({ playAudio: isReading });
});

elements.next.addEventListener("click", () => {
  goNext({ playAudio: isReading });
});

elements.play.addEventListener("click", () => {
  if (isReading) {
    pauseAudio();
  } else {
    playCurrentAudio();
  }
});

elements.edit.addEventListener("click", () => {
  setEditingMode(!isEditing);
});

elements.audio.addEventListener("ended", () => {
  if (elements.autoAdvance.checked && currentIndex < book.pages.length - 1) {
    goNext({ playAudio: true });
  } else {
    isReading = false;
    setPlaybackPaneVisible(true);
    updateNavigation();
  }
});

elements.imageFrame.addEventListener("click", (event) => {
  if (!isReading || event.target.closest(".playback-pane")) {
    return;
  }

  setPlaybackPaneVisible(true);
});

elements.content.addEventListener("input", () => {
  dirty = elements.content.value !== currentPage().content;
  setStatus(dirty ? "Unsaved" : "");
});

elements.save.addEventListener("click", saveCurrentPage);
elements.shelfToggle.addEventListener("click", () => {
  setShelfOpen(!isShelfOpen);
});

elements.shelfClose.addEventListener("click", () => {
  setShelfOpen(false);
});

elements.shelfScrim.addEventListener("click", () => {
  setShelfOpen(false);
});

document.addEventListener("keydown", (event) => {
  const isEditingText = document.activeElement === elements.content;
  if (isEditingText) {
    return;
  }

  if (event.key === "Escape" && isShelfOpen) {
    setShelfOpen(false);
    elements.shelfToggle.focus();
    return;
  }

  if (event.key === "ArrowLeft") {
    goPrevious({ playAudio: isReading });
  }

  if (event.key === "ArrowRight") {
    goNext({ playAudio: isReading });
  }

  if (event.key === " ") {
    event.preventDefault();
    elements.play.click();
  }
});

async function init() {
  elements.shelfPanel.setAttribute("tabindex", "-1");
  setShelfOpen(false);
  setPlaybackPaneVisible(true);

  try {
    const response = await fetch("/api/books");
    if (!response.ok) {
      throw new Error("Books not found.");
    }
    books = await response.json();
    renderShelf();
    const requestedBookId = new URLSearchParams(window.location.search).get("book");
    const firstBookId = books.some((shelfBook) => shelfBook.id === requestedBookId)
      ? requestedBookId
      : books[0]?.id;

    if (!firstBookId) {
      throw new Error("No books found.");
    }

    await selectBook(firstBookId, { updateUrl: Boolean(requestedBookId) });
  } catch {
    elements.title.textContent = "Could not load bookshelf";
    elements.pageCount.textContent = "";
    elements.save.disabled = true;
    elements.play.disabled = true;
    elements.previous.disabled = true;
    elements.next.disabled = true;
    elements.edit.disabled = true;
  }
}

window.addEventListener("beforeunload", (event) => {
  if (!dirty) {
    return;
  }
  event.preventDefault();
  event.returnValue = "";
});

init();
