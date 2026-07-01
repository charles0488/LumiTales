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
  autoAdvance: document.querySelector("#autoAdvance"),
  status: document.querySelector("#playbackStatus"),
  questionDialog: document.querySelector("#questionDialog"),
  questionDialogTitle: document.querySelector("#questionDialogTitle"),
  questionDialogMessage: document.querySelector("#questionDialogMessage"),
  questionConfirm: document.querySelector("#questionConfirm"),
  questionCancel: document.querySelector("#questionCancel"),
  accountName: document.querySelector("#accountName")
};

const questionDelayMs = 30000;
const fallbackQuestionPrompts = {
  before_reading: "I have a few questions for you. Are you ready for the questions?",
  after_reading: "Now, this is the end of the story. Are you ready for a few questions?"
};

let books = [];
let book;
let bookId;
let currentIndex = 0;
let isReading = false;
let statusTimer;
let isShelfOpen = false;
let isPlaybackPaneVisible = true;
let playbackQueue = [];
let playbackCursor = 0;
let activePlaybackItem = null;
let playbackDelayTimer;
let queueCompletion;
let questionDialogKind = null;
let playedBeforeReadingQuestions = false;
let playedAfterReadingQuestions = false;

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

function questionAudioPath(question) {
  return assetPath(question.audio);
}

function currentPage() {
  return book.pages[currentIndex];
}

function questionSection(kind) {
  return book?.questions?.[kind];
}

function questionsFor(kind) {
  const section = questionSection(kind);
  const questions = Array.isArray(section) ? section : section?.questions;
  return (questions || []).filter((question) => question?.audio?.path);
}

function promptFor(kind) {
  const section = questionSection(kind);
  if (Array.isArray(section)) {
    return {
      text: fallbackQuestionPrompts[kind],
      audio: null
    };
  }

  return {
    text: section?.prompt?.text || fallbackQuestionPrompts[kind],
    audio: section?.prompt?.audio || null
  };
}

function clearPlaybackQueue() {
  window.clearTimeout(playbackDelayTimer);
  playbackDelayTimer = null;
  queueCompletion = null;
  playbackQueue = [];
  playbackCursor = 0;
  activePlaybackItem = null;
}

async function speakPrompt(prompt) {
  if (!prompt.audio?.path) {
    return;
  }

  activePlaybackItem = { type: "prompt" };
  elements.audio.src = assetPath(prompt.audio);
  try {
    elements.audio.currentTime = 0;
    await elements.audio.play();
  } catch {
    setStatus("Press Yes when ready");
  }
}

function showQuestionDialog(kind) {
  const questions = questionsFor(kind);
  if (questions.length === 0) {
    return false;
  }

  const prompt = promptFor(kind);
  questionDialogKind = kind;
  isReading = false;
  elements.questionDialogTitle.textContent = "Ready for questions?";
  elements.questionDialogMessage.textContent = prompt.text;
  elements.questionDialog.hidden = false;
  setPlaybackPaneVisible(true);
  updateNavigation();
  speakPrompt(prompt);
  elements.questionConfirm.focus();
  return true;
}

function hideQuestionDialog() {
  questionDialogKind = null;
  elements.questionDialog.hidden = true;
  if (activePlaybackItem?.type === "prompt") {
    elements.audio.pause();
    elements.audio.currentTime = 0;
    activePlaybackItem = null;
  }
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
  if (!hasBook) {
    return;
  }

  elements.play.textContent = isReading ? "⏸" : "▶";
  elements.play.setAttribute("aria-label", isReading ? "Pause" : "Play");
}

function renderPage({ playAudio = isReading } = {}) {
  const page = currentPage();
  clearPlaybackQueue();
  elements.title.textContent = book.title;
  elements.pageCount.textContent = `Page ${currentIndex + 1} of ${book.pages.length}`;
  elements.image.src = assetPath(page.image);
  elements.image.alt = `${book.title}, page ${page.page_number}`;
  elements.audio.src = audioPath(page);
  updateNavigation();

  if (playAudio) {
    playCurrentAudio();
  } else {
    elements.audio.pause();
    elements.audio.currentTime = 0;
  }
}

async function playAudioElement({ restart = true } = {}) {
  isReading = true;
  updateNavigation();

  try {
    if (restart) {
      elements.audio.currentTime = 0;
    }
    await elements.audio.play();
    setPlaybackPaneVisible(false);
  } catch {
    isReading = false;
    setPlaybackPaneVisible(true);
    updateNavigation();
    setStatus("Press Play to start audio");
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
  await playQueuedAudio([{ type: "page", pageIndex: currentIndex }]);
}

async function playQueuedAudio(queue, { onComplete } = {}) {
  window.clearTimeout(playbackDelayTimer);
  playbackDelayTimer = null;
  playbackQueue = queue;
  playbackCursor = 0;
  queueCompletion = onComplete;
  await playNextQueuedAudio();
}

async function playNextQueuedAudio() {
  window.clearTimeout(playbackDelayTimer);
  playbackDelayTimer = null;
  activePlaybackItem = playbackQueue[playbackCursor] || null;
  playbackCursor += 1;

  if (!activePlaybackItem) {
    completePlaybackQueue();
    return;
  }

  if (activePlaybackItem.type === "question") {
    elements.audio.src = questionAudioPath(activePlaybackItem.question);
  } else if (activePlaybackItem.type === "delay") {
    isReading = true;
    updateNavigation();
    setPlaybackPaneVisible(false);
    playbackDelayTimer = window.setTimeout(() => {
      playNextQueuedAudio();
    }, activePlaybackItem.duration);
    return;
  } else {
    const page = book.pages[activePlaybackItem.pageIndex];
    elements.audio.src = audioPath(page);
  }

  await playAudioElement();
}

function pauseAudio() {
  isReading = false;
  elements.audio.pause();
  window.clearTimeout(playbackDelayTimer);
  playbackDelayTimer = null;
  setPlaybackPaneVisible(true);
  updateNavigation();
}

function stopPlayback() {
  isReading = false;
  clearPlaybackQueue();
  setPlaybackPaneVisible(true);
  updateNavigation();
}

function completePlaybackQueue() {
  const onComplete = queueCompletion;
  clearPlaybackQueue();
  if (onComplete) {
    onComplete();
    return;
  }
  stopPlayback();
}

function questionPlaybackQueue(kind) {
  return questionsFor(kind).flatMap((question, index, questions) => {
    const item = {
      type: "question",
      kind,
      question
    };

    if (index === questions.length - 1) {
      return [item];
    }

    return [item, { type: "delay", duration: questionDelayMs }];
  });
}

function startQuestionPlayback(kind) {
  hideQuestionDialog();
  const queue = questionPlaybackQueue(kind);
  if (queue.length === 0) {
    completeQuestionFlow(kind);
    return;
  }

  playQueuedAudio(queue, {
    onComplete: () => completeQuestionFlow(kind)
  });
}

function completeQuestionFlow(kind) {
  if (kind === "before_reading" && elements.autoAdvance.checked && currentIndex < book.pages.length - 1) {
    goNext({ playAudio: true });
    return;
  }

  stopPlayback();
}

function skipQuestionPlayback(kind) {
  hideQuestionDialog();
  completeQuestionFlow(kind);
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

async function selectBook(nextBookId, { updateUrl = true } = {}) {
  pauseAudio();
  clearPlaybackQueue();
  hideQuestionDialog();
  bookId = nextBookId;
  book = null;
  currentIndex = 0;
  playedBeforeReadingQuestions = false;
  playedAfterReadingQuestions = false;
  elements.title.textContent = "Loading...";
  elements.pageCount.textContent = "";
  elements.image.removeAttribute("src");
  elements.image.alt = "";
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
    elements.play.disabled = true;
    elements.previous.disabled = true;
    elements.next.disabled = true;
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
  } else if (activePlaybackItem && elements.audio.currentTime > 0 && !elements.audio.ended) {
    playAudioElement({ restart: false });
  } else {
    playCurrentAudio();
  }
});

elements.questionConfirm.addEventListener("click", () => {
  if (questionDialogKind) {
    startQuestionPlayback(questionDialogKind);
  }
});

elements.questionCancel.addEventListener("click", () => {
  if (questionDialogKind) {
    skipQuestionPlayback(questionDialogKind);
  }
});

elements.audio.addEventListener("ended", () => {
  if (playbackCursor < playbackQueue.length) {
    playNextQueuedAudio();
    return;
  }

  const endedItem = activePlaybackItem;

  if (endedItem?.type === "question") {
    completePlaybackQueue();
    return;
  }

  clearPlaybackQueue();

  if (endedItem?.type !== "page") {
    stopPlayback();
    return;
  }

  if (currentIndex === 0 && !playedBeforeReadingQuestions) {
    playedBeforeReadingQuestions = true;
    if (showQuestionDialog("before_reading")) {
      return;
    }
  }

  if (elements.autoAdvance.checked && currentIndex < book.pages.length - 1) {
    goNext({ playAudio: true });
  } else if (currentIndex === book.pages.length - 1 && !playedAfterReadingQuestions) {
    playedAfterReadingQuestions = true;
    if (showQuestionDialog("after_reading")) {
      return;
    }
    stopPlayback();
  } else {
    stopPlayback();
  }
});

elements.imageFrame.addEventListener("click", (event) => {
  if (!isReading || event.target.closest(".playback-pane")) {
    return;
  }

  setPlaybackPaneVisible(true);
});

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
  if (questionDialogKind) {
    if (event.key === "Escape") {
      skipQuestionPlayback(questionDialogKind);
    }
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
    const meResponse = await fetch("/api/me");
    if (meResponse.ok) {
      const { user } = await meResponse.json();
      elements.accountName.textContent = user?.name || user?.email || "Signed in";
    }

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
    elements.play.disabled = true;
    elements.previous.disabled = true;
    elements.next.disabled = true;
  }
}

init();
