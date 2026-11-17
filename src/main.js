import '@fontsource/bebas-neue/400.css';
import '@fontsource-variable/inter';
import '@fontsource/orbitron/600.css';
import '@fontsource/orbitron/700.css';
import './style.css';

import { state } from './ui/state.js';
import { unlockOnGesture } from './player.js';
import { initNotices } from './ui/notices.js';
import { initTabs, initHowto } from './ui/tabs.js';
import { initDropzone } from './ui/dropzone.js';
import { initLibraryUi, initProgressUi } from './ui/library-ui.js';
import { initTranscript } from './ui/transcript.js';
import { initWorkspace } from './ui/workspace.js';
import { initClips } from './ui/clips.js';
import { initSearch } from './ui/search.js';
import { initExport } from './ui/exportPanel.js';
import { initBuilder, setBuilderLines } from './ui/builder.js';
import { initShortcuts } from './ui/shortcuts.js';
import { initPhrases } from './ui/phrases-ui.js';

unlockOnGesture();
initNotices();
initTabs();
initHowto();
initDropzone();
initLibraryUi();
initProgressUi();
initTranscript();
initWorkspace();
initClips();
initSearch();
initExport();
initBuilder();
initPhrases();
initShortcuts();

window.__vox = { state, ready: true, setBuilderLines };
document.documentElement.dataset.ready = 'true';
