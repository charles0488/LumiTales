const bookId = "doing_my_chores";

const elements = {
  title: document.querySelector("#bookTitle"),
  pageCount: document.querySelector("#pageCount"),
  image: document.querySelector("#pageImage"),
  audio: document.querySelector("#audioPlayer"),
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

let book;
let currentIndex = 0;
let isReading = false;
let isEditing = false;
let dirty = false;
let statusTimer;

function assetPath(asset) {
  return asset?.path?.replace(/^\.\//, "/") || "";
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

function updateNavigation() {
  elements.previous.disabled = currentIndex === 0;
  elements.next.disabled = currentIndex === book.pages.length - 1;
  elements.play.textContent = isReading ? "Pause" : "Play";
  elements.edit.textContent = isEditing ? "Close" : "Edit";
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

async function playCurrentAudio() {
  isReading = true;
  updateNavigation();

  try {
    elements.audio.currentTime = 0;
    await elements.audio.play();
  } catch {
    isReading = false;
    updateNavigation();
    setStatus("Press Play to start audio");
  }
}

function pauseAudio() {
  isReading = false;
  elements.audio.pause();
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
    updateNavigation();
  }
});

elements.content.addEventListener("input", () => {
  dirty = elements.content.value !== currentPage().content;
  setStatus(dirty ? "Unsaved" : "");
});

elements.save.addEventListener("click", saveCurrentPage);

document.addEventListener("keydown", (event) => {
  const isEditingText = document.activeElement === elements.content;
  if (isEditingText) {
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
  try {
    const response = await fetch(`/api/books/${bookId}`);
    if (!response.ok) {
      throw new Error("Book not found.");
    }
    book = await response.json();
    book.pages.sort((a, b) => a.page_number - b.page_number);
    renderPage({ playAudio: false });
  } catch {
    elements.title.textContent = "Could not load book";
    elements.pageCount.textContent = "";
    elements.save.disabled = true;
    elements.play.disabled = true;
    elements.previous.disabled = true;
    elements.next.disabled = true;
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
