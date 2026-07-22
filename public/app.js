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
  askQuestions: document.querySelector("#askQuestions"),
  status: document.querySelector("#playbackStatus"),
  accountName: document.querySelector("#accountName"),
  accountEmail: document.querySelector("#accountEmail"),
  profileToggle: document.querySelector("#profileToggle"),
  profileMenu: document.querySelector("#profileMenu"),
  profileLevel: document.querySelector("#profileLevel"),
  accountRole: document.querySelector("#accountRole"),
  modeNav: document.querySelector("#modeNav"),
  readingModeButton: document.querySelector("#readingModeButton"),
  parentModeButton: document.querySelector("#parentModeButton"),
  readerView: document.querySelector("#readerView"),
  libraryView: document.querySelector("#libraryView"),
  libraryGrid: document.querySelector("#libraryGrid"),
  librarySelectionCount: document.querySelector("#librarySelectionCount"),
  libraryStatus: document.querySelector("#libraryStatus"),
  familyBookGrid: document.querySelector("#familyBookGrid"),
  addFamilyBookButton: document.querySelector("#addFamilyBookButton"),
  addPublicBookButton: document.querySelector("#addPublicBookButton"),
  bookCreatorKicker: document.querySelector("#bookCreatorKicker"),
  familyBookPopover: document.querySelector("#familyBookPopover"),
  closeFamilyBookPopover: document.querySelector("#closeFamilyBookPopover"),
  parentGate: document.querySelector("#parentGate"),
  parentGateForm: document.querySelector("#parentGateForm"),
  parentGateTitle: document.querySelector("#parentGateTitle"),
  parentGateHint: document.querySelector("#parentGateHint"),
  parentGateLabel: document.querySelector("#parentGateLabel"),
  parentPin: document.querySelector("#parentPin"),
  parentPinConfirmation: document.querySelector("#parentPinConfirmation"),
  parentPinConfirmationLabel: document.querySelector("#parentPinConfirmationLabel"),
  parentPasswordLabel: document.querySelector("#parentPasswordLabel"),
  parentAccountPassword: document.querySelector("#parentAccountPassword"),
  forgotParentPinButton: document.querySelector("#forgotParentPinButton"),
  parentGateStatus: document.querySelector("#parentGateStatus"),
  parentGateCancel: document.querySelector("#parentGateCancel"),
  profileControl: document.querySelector(".profile-control"),
  resetPinButton: document.querySelector("#resetPinButton"),
  resetPinForm: document.querySelector("#resetPinForm"),
  newParentPin: document.querySelector("#newParentPin"),
  confirmNewParentPin: document.querySelector("#confirmNewParentPin"),
  resetPinStatus: document.querySelector("#resetPinStatus")
};

const questionDelayMs = 10000;

let books = [];
let book;
let bookId;
let readingLevel = Number(localStorage.getItem("lumitales-reading-level")) || 1;
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
let playedBeforeReadingQuestions = false;
let playedAfterReadingQuestions = false;
let currentUser;
let libraryBooks = [];
let ownedLibraryBooks = [];
let familyBooks = [];
let publicBookJobs = [];
let creatorVisibility = "private";
let familyStatusTimer;
let familyDeleteTimer;
let familyBookDeleteAfterMs = 3 * 60 * 1000;
let remainingCheckoutSlots = 5;
let parentPin = "";
let isSettingParentPin = false;
let isResettingForgottenPin = false;
let parentIdleTimer;
const libraryCoverUrls = new Map();
const parentIdleTimeoutMs = 5 * 60 * 1000;

function userIsParent() {
  return currentUser?.role === "parent" || currentUser?.role === "admin";
}

function setMode(mode) {
  const nextMode = mode === "parent" && userIsParent() ? "parent" : "reading";
  elements.readerView.hidden = nextMode !== "reading";
  elements.libraryView.hidden = nextMode !== "parent";
  elements.readingModeButton.setAttribute("aria-current", nextMode === "reading" ? "page" : "false");
  elements.parentModeButton.setAttribute("aria-current", nextMode === "parent" ? "page" : "false");
  elements.profileControl.hidden = nextMode === "reading";
  const url = new URL(window.location.href);
  url.searchParams.set("mode", nextMode);
  window.history.replaceState({}, "", url);
  if (nextMode === "parent") {
    resetParentIdleTimer();
    loadLibrary();
  } else {
    lockParentMode();
  }
}

function lockParentMode() {
  window.clearTimeout(parentIdleTimer);
  parentPin = "";
  for (const objectUrl of libraryCoverUrls.values()) URL.revokeObjectURL(objectUrl);
  libraryCoverUrls.clear();
  elements.profileMenu.hidden = true;
}

function resetParentIdleTimer() {
  window.clearTimeout(parentIdleTimer);
  if (parentPin) parentIdleTimer = window.setTimeout(() => setMode("reading"), parentIdleTimeoutMs);
}

async function requestParentMode() {
  const response = await fetch("/api/parent-pin");
  const payload = await response.json();
  if (!response.ok) return;
  isSettingParentPin = !payload.configured;
  isResettingForgottenPin = false;
  elements.parentGateTitle.textContent = isSettingParentPin ? "Create parent PIN" : "Enter parent PIN";
  elements.parentGateHint.textContent = isSettingParentPin
    ? "Choose 4 to 8 digits. This PIN protects library, account, and checkout controls."
    : "Enter your PIN to open Parent Library.";
  elements.parentGateLabel.textContent = isSettingParentPin ? "New parent PIN" : "Parent PIN";
  elements.parentPinConfirmationLabel.hidden = !isSettingParentPin;
  elements.parentPinConfirmation.required = isSettingParentPin;
  elements.parentPasswordLabel.hidden = true;
  elements.parentAccountPassword.required = false;
  elements.forgotParentPinButton.hidden = isSettingParentPin;
  elements.parentPin.value = "";
  elements.parentPinConfirmation.value = "";
  elements.parentAccountPassword.value = "";
  elements.parentGateStatus.textContent = "";
  elements.parentGate.hidden = false;
  elements.parentPin.focus();
}

function closeParentGate() {
  elements.parentGate.hidden = true;
  elements.parentGateStatus.textContent = "";
}

function createLibraryCard(item) {
    const card = document.createElement("article");
    card.className = "library-card";
    const image = document.createElement("img");
    image.alt = `${item.title} cover`;
    loadLibraryCover(item, image);
    const content = document.createElement("div");
    const title = document.createElement("h2");
    title.textContent = item.title;
    const meta = document.createElement("p");
    meta.textContent = `${item.pageCount} pages · Levels ${item.levels.join(", ")}`;
    const action = document.createElement("button");
    action.type = "button";
    action.textContent = item.checkedOut ? "Return" : "Check out";
    action.className = item.checkedOut ? "return-button" : "";
    const checkoutUnavailable = !item.checkedOut && remainingCheckoutSlots === 0;
    action.disabled = checkoutUnavailable;
    if (checkoutUnavailable) action.title = "Return a checked-out book before checking out another.";
    action.addEventListener("click", () => {
      action.disabled = true;
      return updateCheckout(item);
    });
    const actions = document.createElement("div");
    actions.className = "library-card-actions";
    actions.append(action);
    if (currentUser?.role === "admin") {
      const deleteAction = document.createElement("button");
      deleteAction.type = "button";
      deleteAction.className = "delete-book-button";
      deleteAction.textContent = "Delete";
      deleteAction.addEventListener("click", () => deleteLibraryBook(item));
      actions.append(deleteAction);
    }
    content.append(title, meta, actions);
    card.append(image, content);
    return card;
}

function renderLibrary() {
  const checkedOutCount = [...libraryBooks, ...ownedLibraryBooks].filter((item) => item.checkedOut).length;
  elements.librarySelectionCount.textContent = `${checkedOutCount} of 5 checked out`;
  elements.libraryGrid.replaceChildren(...libraryBooks.map(createLibraryCard), ...publicBookJobs.map(createJobCard));
}

async function deleteLibraryBook(item) {
  if (!window.confirm(`Delete “${item.title}” for every user? This cannot be undone.`)) return;
  elements.libraryStatus.textContent = `Deleting ${item.title}…`;
  const response = await fetch(`/api/library/${encodeURIComponent(item.id)}`, {
    method: "DELETE",
    headers: { "x-parent-pin": parentPin }
  });
  const payload = await response.json();
  if (!response.ok) {
    elements.libraryStatus.textContent = payload.error || "Could not delete book.";
    return;
  }
  elements.libraryStatus.textContent = `${item.title} deleted.`;
  await loadLibrary();
  await loadBooks({ autoSelect: true });
}

async function loadLibraryCover(item, image) {
  if (libraryCoverUrls.has(item.id)) {
    image.src = libraryCoverUrls.get(item.id);
    return;
  }
  try {
    const response = await fetch(`/api/library/${item.id}/cover`, { headers: { "x-parent-pin": parentPin } });
    if (!response.ok) return;
    const objectUrl = URL.createObjectURL(await response.blob());
    libraryCoverUrls.set(item.id, objectUrl);
    if (image.isConnected) image.src = objectUrl;
  } catch {}
}

async function loadLibrary() {
  elements.libraryStatus.textContent = "Loading library…";
  try {
    const response = await fetch("/api/library", { headers: { "x-parent-pin": parentPin } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load library.");
    libraryBooks = payload.books.filter((item) => !item.owned);
    ownedLibraryBooks = payload.books.filter((item) => item.owned);
    remainingCheckoutSlots = payload.remainingCheckoutSlots;
    elements.libraryStatus.textContent = "";
    renderLibrary();
    await loadFamilyBooks();
  } catch (error) {
    elements.libraryStatus.textContent = error.message;
  }
}

function createJobCard(item) {
  const card = document.createElement("article");
  card.className = "family-book-card";
  const title = document.createElement("h3");
  title.textContent = item.title;
  const source = document.createElement("p");
  source.textContent = `${item.sourceType === "pdf" ? "PDF import" : item.sourceType === "images" ? "Image book" : "Story prompt"} · ${new Date(item.createdAt).toLocaleString()}`;
  const detail = document.createElement("p");
  detail.textContent = item.detail || "Waiting for an update.";
  const status = document.createElement("span");
  status.className = "family-book-status";
  status.dataset.status = item.status;
  status.textContent = item.status;
  card.append(title, source, detail, status);
  const isTerminal = item.status === "failed" || item.status === "succeeded";
  const eligibleAt = Date.parse(item.deleteAvailableAt) || (Date.parse(item.createdAt) + familyBookDeleteAfterMs);
  if (isTerminal || item.canDelete || Date.now() >= eligibleAt) {
    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "delete-family-job-button";
    deleteButton.textContent = "Delete";
    deleteButton.addEventListener("click", () => deleteFamilyBookJob(item));
    card.append(deleteButton);
  }
  return card;
}

function renderFamilyBooks() {
  window.clearTimeout(familyDeleteTimer);
  if (!familyBooks.length && !ownedLibraryBooks.length) {
    const empty = document.createElement("p");
    empty.className = "family-book-empty";
    empty.textContent = "No family books yet. Use + to create one.";
    elements.familyBookGrid.replaceChildren(empty);
  } else {
    elements.familyBookGrid.replaceChildren(...ownedLibraryBooks.map(createLibraryCard), ...familyBooks.map(createJobCard));
  }
  renderLibrary();
  const nextEligibleAt = Math.min(...[...familyBooks, ...publicBookJobs]
    .filter((item) => !item.canDelete && item.status !== "failed" && item.status !== "succeeded")
    .map((item) => Date.parse(item.deleteAvailableAt) || (Date.parse(item.createdAt) + familyBookDeleteAfterMs))
    .filter((eligibleAt) => eligibleAt > Date.now()));
  if (Number.isFinite(nextEligibleAt)) {
    familyDeleteTimer = window.setTimeout(renderFamilyBooks, Math.max(0, nextEligibleAt - Date.now()) + 50);
  }
}

async function deleteFamilyBookJob(item) {
  if (!window.confirm(`Remove “${item.title}” from creation history?`)) return;
  const response = await fetch(`/api/family-books/${encodeURIComponent(item.id)}`, {
    method: "DELETE",
    headers: { "x-parent-pin": parentPin }
  });
  const payload = await response.json();
  if (!response.ok) {
    elements.libraryStatus.textContent = payload.error || "Could not delete family book job.";
    return;
  }
  elements.libraryStatus.textContent = `${item.title} removed.`;
  await loadFamilyBooks();
}

async function loadFamilyBooks() {
  window.clearTimeout(familyStatusTimer);
  try {
    const response = await fetch("/api/book-jobs", { headers: { "x-parent-pin": parentPin } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Could not load family books.");
    familyBooks = payload.books.filter((item) => item.visibility !== "public" &&
      !ownedLibraryBooks.some((book) => book.id === item.bookId));
    publicBookJobs = payload.books.filter((item) => item.visibility === "public" &&
      !libraryBooks.some((book) => book.id === item.bookId));
    familyBookDeleteAfterMs = payload.deleteAfterMs;
    elements.addFamilyBookButton.disabled = !payload.configured;
    elements.addPublicBookButton.disabled = !payload.configured;
    elements.addFamilyBookButton.title = payload.configured ? "Create a family book" : "LumiTale Web is not configured";
    renderFamilyBooks();
    const hasActiveJob = [...familyBooks, ...publicBookJobs]
      .some((item) => item.status === "accepted" || item.status === "working");
    const isWaitingForFamilyBook = familyBooks
      .some((item) => item.status === "succeeded" && item.bookId);
    if (isWaitingForFamilyBook) {
      familyStatusTimer = window.setTimeout(() => loadLibrary(), 3000);
    } else if (hasActiveJob) {
      familyStatusTimer = window.setTimeout(loadFamilyBooks, 3000);
    }
  } catch (error) {
    elements.libraryStatus.textContent = error.message;
  }
}

function setFamilyPopover(open, visibility = creatorVisibility) {
  creatorVisibility = visibility;
  elements.familyBookPopover.hidden = !open;
  elements.addFamilyBookButton.setAttribute("aria-expanded", String(open));
  elements.addPublicBookButton.setAttribute("aria-expanded", String(open));
  elements.bookCreatorKicker.textContent = visibility === "public" ? "New public library book" : "New family book";
  if (open) elements.familyBookPopover.querySelector('[role="tab"][aria-selected="true"]').focus();
}

function selectFamilyTab(selected) {
  const tabs = [...elements.familyBookPopover.querySelectorAll('[role="tab"]')];
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute("aria-controls")).hidden = !active;
  }
  selected.focus();
}

async function updateCheckout(item) {
  elements.libraryStatus.textContent = item.checkedOut ? `Returning ${item.title}…` : `Checking out ${item.title}…`;
  const response = await fetch(item.checkedOut ? `/api/checkouts/${item.id}/return` : "/api/checkouts", {
    method: "POST",
    headers: { "content-type": "application/json", "x-parent-pin": parentPin },
    body: item.checkedOut ? undefined : JSON.stringify({ bookIds: [item.id] })
  });
  const payload = await response.json();
  if (!response.ok) {
    elements.libraryStatus.textContent = payload.error || "Could not update checkout.";
    renderLibrary();
    return;
  }
  elements.libraryStatus.textContent = item.checkedOut ? `${item.title} returned.` : `${item.title} is ready to read.`;
  await loadLibrary();
  await loadBooks({ autoSelect: true, preferredBookId: item.checkedOut ? null : item.id });
}

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

function questionPromptAudio(kind) {
  const section = questionSection(kind);
  return Array.isArray(section) ? null : section?.prompt?.audio;
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

function clearPlaybackQueue() {
  window.clearTimeout(playbackDelayTimer);
  playbackDelayTimer = null;
  queueCompletion = null;
  playbackQueue = [];
  playbackCursor = 0;
  activePlaybackItem = null;
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
  elements.pageCount.textContent = `Level ${readingLevel} · Page ${currentIndex + 1} of ${book.pages.length}`;
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
      meta.textContent = `${shelfBook.pageCount} pages · Levels ${shelfBook.levels.join(", ")}`;

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

  if (activePlaybackItem.type === "prompt") {
    elements.audio.src = assetPath(activePlaybackItem.audio);
  } else if (activePlaybackItem.type === "question") {
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
  const questions = questionsFor(kind);
  if (questions.length === 0) {
    return [];
  }

  const promptAudio = questionPromptAudio(kind);
  const queue = promptAudio?.path ? [{ type: "prompt", kind, audio: promptAudio }] : [];

  queue.push(...questions.flatMap((question, index) => {
    const item = {
      type: "question",
      kind,
      question
    };

    if (index === questions.length - 1) {
      return [item];
    }

    return [item, { type: "delay", kind, duration: questionDelayMs }];
  }));

  return queue;
}

function startQuestionPlayback(kind) {
  const queue = questionPlaybackQueue(kind);
  if (queue.length === 0) {
    return false;
  }

  playQueuedAudio(queue, {
    onComplete: () => completeQuestionFlow(kind)
  });
  return true;
}

function completeQuestionFlow(kind) {
  if (kind === "before_reading" && elements.autoAdvance.checked && currentIndex < book.pages.length - 1) {
    goNext({ playAudio: true });
    return;
  }

  stopPlayback();
}

function skipQuestionPlayback(kind) {
  elements.audio.pause();
  window.clearTimeout(playbackDelayTimer);
  playbackDelayTimer = null;
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
    const shelfBook = books.find((candidate) => candidate.id === bookId);
    const availableLevels = shelfBook?.levels || [];
    if (!availableLevels.includes(readingLevel)) {
      readingLevel = availableLevels[0];
    }
    const response = await fetch(`/api/books/${bookId}?level=${readingLevel}`);
    if (!response.ok) {
      throw new Error("Book not found.");
    }
    book = await response.json();
    readingLevel = book.level;
    book.pages.sort((a, b) => a.page_number - b.page_number);
    elements.profileLevel.value = String(readingLevel);
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("book", bookId);
      url.searchParams.set("level", String(readingLevel));
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

elements.askQuestions.addEventListener("change", () => {
  const questionKind = ["prompt", "question", "delay"].includes(activePlaybackItem?.type)
    ? activePlaybackItem.kind
    : null;

  if (!elements.askQuestions.checked && questionKind) {
    skipQuestionPlayback(questionKind);
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

  if (currentIndex === 0 && !playedBeforeReadingQuestions && elements.askQuestions.checked) {
    playedBeforeReadingQuestions = true;
    if (startQuestionPlayback("before_reading")) {
      return;
    }
  }

  if (elements.autoAdvance.checked && currentIndex < book.pages.length - 1) {
    goNext({ playAudio: true });
  } else if (currentIndex === book.pages.length - 1 && !playedAfterReadingQuestions && elements.askQuestions.checked) {
    playedAfterReadingQuestions = true;
    if (startQuestionPlayback("after_reading")) {
      return;
    }
    stopPlayback();
  } else {
    stopPlayback();
  }
});

elements.imageFrame.addEventListener("click", (event) => {
  if (
    event.target.closest(".playback-pane") ||
    event.target.closest(".bookshelf-toggle, .book-meta, .profile-control")
  ) {
    return;
  }

  setPlaybackPaneVisible(!isPlaybackPaneVisible);
  event.stopPropagation();
});

document.addEventListener("click", (event) => {
  if (!isPlaybackPaneVisible || event.target.closest(".playback-pane")) {
    return;
  }

  setPlaybackPaneVisible(false);
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

elements.profileLevel.addEventListener("change", () => {
  readingLevel = Number(elements.profileLevel.value);
  localStorage.setItem("lumitales-reading-level", String(readingLevel));
  selectBook(bookId);
});

elements.profileToggle.addEventListener("click", (event) => {
  const isOpen = elements.profileMenu.hidden;
  elements.profileMenu.hidden = !isOpen;
  elements.profileToggle.setAttribute("aria-expanded", String(isOpen));
  event.stopPropagation();
});

elements.resetPinButton.addEventListener("click", () => {
  elements.resetPinForm.hidden = !elements.resetPinForm.hidden;
  elements.resetPinStatus.textContent = "";
  if (!elements.resetPinForm.hidden) elements.newParentPin.focus();
});
elements.resetPinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const nextPin = elements.newParentPin.value;
  if (nextPin !== elements.confirmNewParentPin.value) {
    elements.resetPinStatus.textContent = "PINs do not match.";
    return;
  }
  const response = await fetch("/api/parent-pin/reset", {
    method: "POST",
    headers: { "content-type": "application/json", "x-parent-pin": parentPin },
    body: JSON.stringify({ pin: nextPin })
  });
  const payload = await response.json();
  if (!response.ok) {
    elements.resetPinStatus.textContent = payload.error || "Could not change PIN.";
    return;
  }
  parentPin = nextPin;
  elements.resetPinForm.reset();
  elements.resetPinForm.hidden = true;
  elements.resetPinStatus.textContent = "";
  setStatus("Parent PIN changed");
  resetParentIdleTimer();
});

elements.readingModeButton.addEventListener("click", () => setMode("reading"));
elements.parentModeButton.addEventListener("click", requestParentMode);
elements.addFamilyBookButton.addEventListener("click", () => setFamilyPopover(true, "private"));
elements.addPublicBookButton.addEventListener("click", () => setFamilyPopover(true, "public"));
elements.closeFamilyBookPopover.addEventListener("click", () => setFamilyPopover(false));
const familyTabs = [...elements.familyBookPopover.querySelectorAll('[role="tab"]')];
familyTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => selectFamilyTab(tab));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    selectFamilyTab(familyTabs[(index + (event.key === "ArrowRight" ? 1 : -1) + familyTabs.length) % familyTabs.length]);
  });
});
for (const input of elements.familyBookPopover.querySelectorAll('input[type="file"]')) {
  input.addEventListener("change", () => {
    const oversized = [...input.files].filter((file) => file.size >= Number(input.dataset.maximumBytes));
    const message = oversized.length
      ? `${input.multiple ? "Each file" : "The file"} must be under ${input.dataset.maximumMb} MB: ${oversized.map((file) => file.name).join(", ")}`
      : "";
    input.setCustomValidity(message);
    input.closest("form").querySelector("output").textContent = message;
  });
}
for (const form of elements.familyBookPopover.querySelectorAll("form")) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const output = form.querySelector("output");
    output.textContent = "Submitting…";
    try {
      const action = new URL(form.action);
      action.searchParams.set("visibility", creatorVisibility);
      const response = await fetch(action, {
        method: "POST",
        headers: { "x-parent-pin": parentPin },
        body: new FormData(form)
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Submission failed.");
      form.reset();
      output.textContent = "Book submitted.";
      await loadFamilyBooks();
      window.setTimeout(() => setFamilyPopover(false), 500);
    } catch (error) {
      output.textContent = error.message;
    }
  });
}
elements.parentGateCancel.addEventListener("click", closeParentGate);
elements.forgotParentPinButton.addEventListener("click", () => {
  isResettingForgottenPin = true;
  elements.parentGateTitle.textContent = "Reset parent PIN";
  elements.parentGateHint.textContent = "Verify the account password, then choose a new 4 to 8 digit PIN.";
  elements.parentGateLabel.textContent = "New parent PIN";
  elements.parentPinConfirmationLabel.hidden = false;
  elements.parentPinConfirmation.required = true;
  elements.parentPasswordLabel.hidden = false;
  elements.parentAccountPassword.required = true;
  elements.forgotParentPinButton.hidden = true;
  elements.parentPin.value = "";
  elements.parentPinConfirmation.value = "";
  elements.parentGateStatus.textContent = "";
  elements.parentAccountPassword.focus();
});
elements.parentGateForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const pin = elements.parentPin.value;
  if ((isSettingParentPin || isResettingForgottenPin) && pin !== elements.parentPinConfirmation.value) {
    elements.parentGateStatus.textContent = "PINs do not match.";
    return;
  }
  const endpoint = isResettingForgottenPin
    ? "/api/parent-pin/forgot"
    : isSettingParentPin ? "/api/parent-pin" : "/api/parent-pin/verify";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pin, password: elements.parentAccountPassword.value })
  });
  const payload = await response.json();
  if (!response.ok) {
    elements.parentGateStatus.textContent = payload.error || "Could not unlock Parent Library.";
    return;
  }
  parentPin = pin;
  closeParentGate();
  setMode("parent");
});

document.addEventListener("pointerdown", () => {
  if (!elements.libraryView.hidden) resetParentIdleTimer();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".profile-control")) {
    elements.profileMenu.hidden = true;
    elements.profileToggle.setAttribute("aria-expanded", "false");
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.familyBookPopover.hidden) {
    setFamilyPopover(false);
    (creatorVisibility === "public" ? elements.addPublicBookButton : elements.addFamilyBookButton).focus();
    return;
  }
  if (event.key === "Escape" && isShelfOpen) {
    setShelfOpen(false);
    elements.shelfToggle.focus();
    return;
  }

  if (event.target.closest("button, input, textarea, select, a")) {
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

async function loadBooks({ autoSelect = false, preferredBookId = null } = {}) {
  const response = await fetch("/api/books");
  if (!response.ok) throw new Error("Books not found.");
  books = await response.json();
  renderShelf();
  if (!books.length) {
    pauseAudio();
    book = null;
    bookId = null;
    elements.title.textContent = userIsParent() ? "Choose books in Parent library" : "No books are ready yet";
    elements.pageCount.textContent = userIsParent() ? "Switch modes to check out up to 5 books." : "Ask a parent to check out a book.";
    elements.image.removeAttribute("src");
    updateNavigation();
    return;
  }
  if (bookId && !books.some((item) => item.id === bookId)) {
    bookId = null;
    book = null;
  }
  if (autoSelect && !book) {
    const nextBookId = books.some((item) => item.id === preferredBookId) ? preferredBookId : books[0].id;
    await selectBook(nextBookId);
  }
}

async function init() {
  elements.shelfPanel.setAttribute("tabindex", "-1");
  setShelfOpen(false);
  setPlaybackPaneVisible(true);

  try {
    const meResponse = await fetch("/api/me");
    if (meResponse.ok) {
      const { user } = await meResponse.json();
      currentUser = user;
      elements.accountName.textContent = user?.name || user?.email || "Signed in";
      elements.accountEmail.textContent = user?.email && user.email !== user?.name ? user.email : "";
      elements.accountRole.textContent = userIsParent() ? "Parent account" : "Kid account · reading only";
      elements.modeNav.hidden = false;
      elements.parentModeButton.hidden = !userIsParent();
      elements.addPublicBookButton.hidden = user?.role !== "admin";
    }

    await loadBooks();
    const requestedBookId = new URLSearchParams(window.location.search).get("book");
    const requestedLevel = Number(new URLSearchParams(window.location.search).get("level"));
    if (Number.isInteger(requestedLevel) && requestedLevel > 0) {
      readingLevel = requestedLevel;
    }
    elements.profileLevel.value = String(readingLevel);
    const firstBookId = books.some((shelfBook) => shelfBook.id === requestedBookId)
      ? requestedBookId
      : books[0]?.id;

    if (firstBookId) await selectBook(firstBookId, { updateUrl: Boolean(requestedBookId) });
    setMode("reading");
  } catch {
    elements.title.textContent = "Could not load bookshelf";
    elements.pageCount.textContent = "";
    elements.play.disabled = true;
    elements.previous.disabled = true;
    elements.next.disabled = true;
  }
}

init();
