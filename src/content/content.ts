import * as XLSX from 'xlsx';
import { initQuickPanelDateControls, type QPDatePreset, type QuickPanelDateControlsApi } from './dateControls';

type CollectionMode = 'lite' | 'synced' | 'precision';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LinkedInEntity = Record<string, any>;

interface PostData {
  activityUrn: string;
  authorName: string;
  authorUrn?: string;
  text?: string;
  timestamp?: number;
  numLikes: number;
  numComments: number;
  numShares: number;
  isSponsored?: boolean;
  hashtags?: string[];
}

let isAutoScrolling = false;
let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
let checkInterval: ReturnType<typeof setInterval> | null = null;
let lastScrollHeight = 0;
let noChangeCount = 0;
let overlayElement: HTMLDivElement | null = null;
let currentCollectionMode: CollectionMode = 'precision';
let autoSortDone = true;
let popupCollectionActive = false;
let isReorderInProgress = false;
let reorderFallbackTimeout: ReturnType<typeof setTimeout> | null = null;

const domElementsCache = new Map<string, Element>();
const originalFeedOrder: string[] = [];
let isReordered = false;

const SCROLL_DELAY = 3000;
const MAX_NO_CHANGE = 4;
const MAX_NO_NEW_POSTS = 8;
const MAX_BUTTON_ATTEMPTS = 3;
const CHECK_INTERVAL = 1500;

let lastPostCount = 0;
let noNewPostsCount = 0;
let buttonAttempts = 0;


function cachePostElements(): void {
  const postElements = document.querySelectorAll('[data-id^="urn:li:activity:"], [data-urn^="urn:li:activity:"]');

  postElements.forEach((el) => {
    const urn = el.getAttribute('data-id') || el.getAttribute('data-urn');
    const activityMatch = urn?.match(/urn:li:activity:(\d+)/);
    if (activityMatch) {
      const normalizedUrn = `urn:li:activity:${activityMatch[1]}`;
      if (!domElementsCache.has(normalizedUrn)) {
        domElementsCache.set(normalizedUrn, el);
        originalFeedOrder.push(normalizedUrn);
      }
    }
  });

}

function getFeedContainer(): Element | null {
  if (isProfileActivityPage()) {
    const scrollContent = document.querySelector('.scaffold-finite-scroll__content');
    if (scrollContent) {
      const ul = scrollContent.querySelector('ul.display-flex');
      if (ul) {
        return ul;
      }
    }
    const fallbackUl = document.querySelector('.pv-recent-activity-detail__core-rail ul.display-flex');
    if (fallbackUl) {
      return fallbackUl;
    }
  }

  const selectors = [
    '.scaffold-finite-scroll__content[data-finite-scroll-hotkey-context="FEED"]',
    '.scaffold-finite-scroll__content',
    '.core-rail .scaffold-finite-scroll__content',
  ];

  for (const selector of selectors) {
    const container = document.querySelector(selector);
    if (container) return container;
  }

  return null;
}

let stopAndSortRequested = false;

function showReorderOverlay(stage: string, progress: string, detail?: string, showStopButton: boolean = false): void {
  let overlay = document.getElementById('linkedin-analyzer-reorder-overlay');

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'linkedin-analyzer-reorder-overlay';
    overlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.8);
      z-index: 999999;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      backdrop-filter: blur(4px);
    `;

    const style = document.createElement('style');
    style.id = 'linkedin-analyzer-reorder-styles';
    style.textContent = `
      @keyframes la-reorder-spin {
        to { transform: rotate(360deg); }
      }
      @keyframes la-reorder-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
    `;
    document.head.appendChild(style);
    document.body.appendChild(overlay);
  }

  const stopButtonHtml = showStopButton
    ? `<button id="la-stop-sort-btn" style="
        margin-top: 16px;
        padding: 10px 28px;
        background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.15s, box-shadow 0.15s;
        box-shadow: 0 2px 8px rgba(220, 38, 38, 0.3);
      ">Stop & Sort Now</button>`
    : '';

  overlay.innerHTML = `
    <div style="
      background: white;
      padding: 40px 60px;
      border-radius: 20px;
      text-align: center;
      box-shadow: 0 25px 80px rgba(0, 0, 0, 0.4);
      max-width: 400px;
    ">
      <div style="
        width: 60px;
        height: 60px;
        border: 4px solid #e5e7eb;
        border-top-color: #034C9D;
        border-radius: 50%;
        margin: 0 auto 24px;
        animation: la-reorder-spin 1s linear infinite;
      "></div>
      <div style="
        font-size: 14px;
        font-weight: 600;
        color: #034C9D;
        text-transform: uppercase;
        letter-spacing: 1px;
        margin-bottom: 8px;
      ">${stage}</div>
      <div id="la-reorder-progress" style="
        font-size: 28px;
        font-weight: 700;
        color: #1a1a1a;
        margin-bottom: 8px;
      ">${progress}</div>
      ${
        detail
          ? `<div id="la-reorder-detail" style="
        font-size: 13px;
        color: #6b7280;
        animation: la-reorder-pulse 2s ease-in-out infinite;
      ">${detail}</div>`
          : ''
      }
      ${stopButtonHtml}
    </div>
  `;

  if (showStopButton) {
    const btn = document.getElementById('la-stop-sort-btn');
    if (btn) {
      btn.addEventListener('click', () => {
        stopAndSortRequested = true;
        btn.textContent = 'Stopping...';
        btn.style.opacity = '0.6';
        btn.style.pointerEvents = 'none';
      });
    }
  }
}

function updateReorderOverlay(stage?: string, progress?: string, detail?: string): void {
  const overlay = document.getElementById('linkedin-analyzer-reorder-overlay');
  if (!overlay) return;

  if (stage) {
    const stageEl = overlay.querySelector('div > div:nth-child(2)');
    if (stageEl) stageEl.textContent = stage;
  }
  if (progress) {
    const progressEl = overlay.querySelector('#la-reorder-progress');
    if (progressEl) progressEl.textContent = progress;
  }
  if (detail !== undefined) {
    const detailEl = overlay.querySelector('#la-reorder-detail');
    if (detailEl) detailEl.textContent = detail;
  }
}

function hideReorderOverlay(): void {
  const overlay = document.getElementById('linkedin-analyzer-reorder-overlay');
  const style = document.getElementById('linkedin-analyzer-reorder-styles');
  if (overlay) overlay.remove();
  if (style) style.remove();
}

function createPostCard(post: PostData, index: number): Element {
  const activityId = post.activityUrn.replace('urn:li:activity:', '');
  const postUrl = `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`;

  const displayText = post.text ? (post.text.length > 300 ? post.text.substring(0, 300) + '...' : post.text) : '';

  const wrapper = document.createElement('div');
  wrapper.innerHTML = `
    <div data-id="urn:li:activity:${activityId}" class="relative" data-finite-scroll-hotkey-item="${index}">
      <div class="full-height" data-view-name="feed-full-update">
        <div class="full-height">
          <div class="feed-shared-update-v2 feed-shared-update-v2--minimal-padding full-height relative artdeco-card" 
               role="article" 
               data-urn="urn:li:activity:${activityId}"
               style="margin-bottom: 8px;">
            <div style="padding: 12px 16px;">
              <!-- Header -->
              <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 12px;">
                <div style="
                  width: 48px; 
                  height: 48px; 
                  background: linear-gradient(135deg, #034C9D 0%, #0066CC 100%);
                  border-radius: 50%;
                  display: flex;
                  align-items: center;
                  justify-content: center;
                  color: white;
                  font-weight: 700;
                  font-size: 18px;
                ">${post.authorName.charAt(0).toUpperCase()}</div>
                <div style="flex: 1;">
                  <a href="${postUrl}" target="_blank" style="
                    font-size: 14px;
                    font-weight: 600;
                    color: rgba(0,0,0,0.9);
                    text-decoration: none;
                  ">${post.authorName}</a>
                  <div style="
                    font-size: 12px;
                    color: rgba(0,0,0,0.6);
                    display: flex;
                    align-items: center;
                    gap: 4px;
                  ">
                    <span style="
                      background: #f0f7ff;
                      color: #034C9D;
                      padding: 2px 8px;
                      border-radius: 10px;
                      font-size: 10px;
                      font-weight: 600;
                    ">From Analyzer</span>
                  </div>
                </div>
                <a href="${postUrl}" target="_blank" style="
                  padding: 6px 12px;
                  background: #034C9D;
                  color: white;
                  border-radius: 16px;
                  font-size: 12px;
                  font-weight: 600;
                  text-decoration: none;
                ">Open Post</a>
              </div>
              
              <!-- Content -->
              ${
                displayText
                  ? `
              <div style="
                font-size: 14px;
                color: rgba(0,0,0,0.9);
                line-height: 1.5;
                margin-bottom: 12px;
                white-space: pre-wrap;
              ">${displayText}</div>
              `
                  : ''
              }
              
              <!-- Stats -->
              <div style="
                display: flex;
                gap: 16px;
                padding-top: 12px;
                border-top: 1px solid #e5e7eb;
                font-size: 12px;
                color: rgba(0,0,0,0.6);
              ">
                <div style="display: flex; align-items: center; gap: 4px;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                  </svg>
                  <span style="font-weight: 600; color: #034C9D;">${post.numLikes.toLocaleString()}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 4px;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                  </svg>
                  <span style="font-weight: 600; color: #034C9D;">${post.numComments.toLocaleString()}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 4px;">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                    <path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                  </svg>
                  <span style="font-weight: 600; color: #034C9D;">${post.numShares.toLocaleString()}</span>
                </div>
                <div style="margin-left: auto; display: flex; align-items: center; gap: 4px;">
                  <span style="
                    background: linear-gradient(135deg, #034C9D 0%, #0066CC 100%);
                    color: white;
                    padding: 4px 10px;
                    border-radius: 12px;
                    font-size: 11px;
                    font-weight: 600;
                  ">Engagement: ${(post.numLikes + post.numComments * 2 + post.numShares * 3).toLocaleString()}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  return wrapper.firstElementChild!;
}

function countPostsInDOM(targetUrns: string[]): { found: Set<string>; missing: string[] } {
  const targetUrnSet = new Set(targetUrns);
  const found = new Set<string>();

  document.querySelectorAll('[data-id^="urn:li:activity:"], [data-urn^="urn:li:activity:"]').forEach((el) => {
    const urn = el.getAttribute('data-id') || el.getAttribute('data-urn');
    const match = urn?.match(/urn:li:activity:(\d+)/);
    if (match) {
      const normalizedUrn = `urn:li:activity:${match[1]}`;
      if (targetUrnSet.has(normalizedUrn)) {
        const container = el.closest('[data-id]') || el;
        const hasContent =
          container.querySelector('.feed-shared-update-v2, .update-components-actor, .feed-shared-text, .update-components-text');
        if (hasContent) {
          found.add(normalizedUrn);
        }
      }
    }
  });

  const missing = targetUrns.filter((urn) => !found.has(urn));
  return { found, missing };
}

async function ensureProfilePostsInDOM(
  targetUrns: string[],
  neededCount: number = 0
): Promise<{ loaded: number; total: number; elements: Map<string, Element> }> {
  const needed = neededCount > 0 ? neededCount : targetUrns.length;

  const targetUrnSet = new Set(targetUrns.slice(0, needed + 10));
  const collectedElements = new Map<string, Element>();

  const scrollTo = (pos: number) => {
    const sc = getScrollContainer();
    try {
      if (sc) (sc as HTMLElement).scrollTop = pos;
      window.scrollTo({ top: pos, behavior: 'auto' });
      document.documentElement.scrollTop = pos;
      document.body.scrollTop = pos;
    } catch (e) { /* ignore */ }
  };

  const scanAndCollect = () => {
    document.querySelectorAll('[data-id^="urn:li:activity:"], [data-urn^="urn:li:activity:"]').forEach((el) => {
      const urn = el.getAttribute('data-id') || el.getAttribute('data-urn');
      const match = urn?.match(/urn:li:activity:(\d+)/);
      if (!match) return;
      const normalizedUrn = `urn:li:activity:${match[1]}`;
      if (!targetUrnSet.has(normalizedUrn)) return;
      if (collectedElements.has(normalizedUrn)) return;

      const wrapper = el.closest('li') || el.closest('[data-finite-scroll-hotkey-item]') || el.closest('[data-id]') || el;
      collectedElements.set(normalizedUrn, wrapper);
    });

    document.querySelectorAll('.scaffold-finite-scroll__content li').forEach((li) => {
      const inner = li.querySelector('[data-id^="urn:li:activity:"], [data-urn^="urn:li:activity:"]');
      if (inner) return;
      const urnEl = li.querySelector('[data-id]');
      const urn = urnEl?.getAttribute('data-id') || '';
      const actMatch = urn.match(/urn:li:activity:(\d+)/);
      if (!actMatch) return;
      const normalizedUrn = `urn:li:activity:${actMatch[1]}`;
      if (!targetUrnSet.has(normalizedUrn) || collectedElements.has(normalizedUrn)) return;
      collectedElements.set(normalizedUrn, li);
    });
  };

  const tryClickLoadMore = (): boolean => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase() || '';
      const isVisible = (btn as HTMLElement).offsetParent !== null;
      if (!isVisible) continue;
      if (btn.classList.contains('scaffold-finite-scroll__load-button')) {
        btn.click();
        return true;
      }
      if (text.includes('показать') && (text.includes('результат') || text.includes('больше'))) { btn.click(); return true; }
      if ((text.includes('show') || text.includes('see')) && (text.includes('new') || text.includes('more'))) { btn.click(); return true; }
      if (text.includes('weitere') || text.includes('mehr')) { btn.click(); return true; }
    }
    return false;
  };

  showReorderOverlay('Step 1: Loading Posts', `0 / ${needed}`, 'Scanning...');

  scrollTo(0);
  await new Promise((r) => setTimeout(r, 500));
  scanAndCollect();

  if (collectedElements.size >= needed) {
    return { loaded: collectedElements.size, total: needed, elements: collectedElements };
  }

  const scrollStep = 800;
  let lastFoundCount = collectedElements.size;
  let noProgressCount = 0;
  let lastScrollHeight = 0;
  let noScrollChangeCount = 0;
  let loadMoreAttempts = 0;

  for (let attempt = 0; attempt < 60; attempt++) {
    if (collectedElements.size >= needed) break;

    scanAndCollect();

    const sc = getScrollContainer();
    const currentScrollHeight = sc?.scrollHeight || document.body.scrollHeight;
    const currentScroll = window.scrollY || document.documentElement.scrollTop;
    const nextScroll = Math.min(currentScroll + scrollStep, currentScrollHeight);

    scrollTo(nextScroll);

    await new Promise((r) => setTimeout(r, 600));
    scanAndCollect();
    await new Promise((r) => setTimeout(r, 600));
    scanAndCollect();

    const displayFound = Math.min(collectedElements.size, needed);
    updateReorderOverlay(undefined, `${displayFound} / ${needed}`, `Scanning... (step ${attempt + 1})`);

    if (currentScrollHeight === lastScrollHeight) {
      noScrollChangeCount++;
      if (noScrollChangeCount >= 4 && loadMoreAttempts < 5) {
        if (tryClickLoadMore()) {
          loadMoreAttempts++;
          noScrollChangeCount = 0;
          await new Promise((r) => setTimeout(r, 2000));
          scanAndCollect();
          continue;
        }
      }
    } else {
      noScrollChangeCount = 0;
      lastScrollHeight = currentScrollHeight;
    }

    if (collectedElements.size > lastFoundCount) {
      noProgressCount = 0;
      lastFoundCount = collectedElements.size;
    } else {
      noProgressCount++;
    }

    if (nextScroll >= currentScrollHeight - 100) {
      scanAndCollect();
      if (collectedElements.size < needed && loadMoreAttempts < 5) {
        if (tryClickLoadMore()) {
          loadMoreAttempts++;
          noScrollChangeCount = 0;
          await new Promise((r) => setTimeout(r, 2000));
          scanAndCollect();
          scrollTo(0);
          await new Promise((r) => setTimeout(r, 500));
          scanAndCollect();
          continue;
        }
      }
      if (collectedElements.size < needed && noProgressCount < 8) {
        scrollTo(0);
        await new Promise((r) => setTimeout(r, 500));
        scanAndCollect();
      } else {
        break;
      }
    }

    if (noProgressCount >= 8) {
      break;
    }
  }

  scrollTo(0);
  await new Promise((r) => setTimeout(r, 500));
  scanAndCollect();

  return { loaded: collectedElements.size, total: needed, elements: collectedElements };
}

async function ensurePostsLoadedInDOM(
  targetUrns: string[],
  neededCount: number = 0
): Promise<{ loaded: number; total: number }> {
  const needed = neededCount > 0 ? neededCount : targetUrns.length;

  const cumulativeFound = new Set<string>();

  const initial = countPostsInDOM(targetUrns);
  initial.found.forEach((urn) => cumulativeFound.add(urn));

  showReorderOverlay(
    'Step 1: Loading Posts',
    `${cumulativeFound.size} / ${needed}`,
    cumulativeFound.size < needed ? `Looking for ${needed - cumulativeFound.size} more posts...` : 'Ready!'
  );

  if (cumulativeFound.size >= needed) {
    return { loaded: cumulativeFound.size, total: needed };
  }

  let lastFoundCount = cumulativeFound.size;
  let noChangeAttempts = 0;
  const maxScrollAttempts = 8; // Reduced: don't scroll endlessly for posts that may not be in DOM
  const scrollStep = 2000;

  for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    const currentScroll = window.scrollY || 0;
    const nextScroll = Math.min(currentScroll + scrollStep, maxScroll);

    window.scrollTo({ top: nextScroll, behavior: 'auto' });
    await new Promise((resolve) => setTimeout(resolve, 600));

    const result = countPostsInDOM(targetUrns);
    result.found.forEach((urn) => cumulativeFound.add(urn));

    const displayFound = Math.min(cumulativeFound.size, needed);
    const stillNeeded = needed - cumulativeFound.size;

    updateReorderOverlay(
      undefined,
      `${displayFound} / ${needed}`,
      stillNeeded > 0 ? `Looking for ${stillNeeded} more posts...` : 'All posts found!'
    );


    if (cumulativeFound.size >= needed) {
      break;
    }

    if (cumulativeFound.size === lastFoundCount) {
      noChangeAttempts++;
      if (noChangeAttempts >= 3) {
        break;
      }
    } else {
      noChangeAttempts = 0;
      lastFoundCount = cumulativeFound.size;
    }

    if (nextScroll >= maxScroll - 100) {
      if (noChangeAttempts >= 1) {
        break;
      }
    }
  }

  const finalResult = countPostsInDOM(targetUrns);
  finalResult.found.forEach((urn) => cumulativeFound.add(urn));

  return { loaded: cumulativeFound.size, total: needed };
}

async function reorderFeedPosts(
  sortedUrns: string[],
  postsData: PostData[] = [],
  skipPlaceholders: boolean = false,
  targetCount: number = 0,
  preCollectedElements?: Map<string, Element>
): Promise<{ success: boolean; reorderedCount: number; message: string }> {
  if (isReorderInProgress) {
    return { success: false, reorderedCount: 0, message: 'Reorder already in progress' };
  }
  isReorderInProgress = true;


  const postsDataMap = new Map<string, PostData>();
  postsData.forEach((p) => postsDataMap.set(p.activityUrn, p));

  try {
    const isProfile = isProfileActivityPage();

    const profileCollected = new Map<string, Element>();

    if (isProfile) {
      if (preCollectedElements && preCollectedElements.size > 0) {
        preCollectedElements.forEach((element, urn) => {
          profileCollected.set(urn, element);
        });
      } else {
        const loadResult = await ensureProfilePostsInDOM(sortedUrns, targetCount);
        loadResult.elements.forEach((element, urn) => {
          profileCollected.set(urn, element);
        });
      }

    } else {
      const loadResult = await ensurePostsLoadedInDOM(sortedUrns, targetCount);
    }

    updateReorderOverlay('Step 2: Preparing', 'Organizing posts...', 'Scrolling back to top');

    window.scrollTo({ top: 0, behavior: 'auto' });
    await new Promise((resolve) => setTimeout(resolve, 500));

    cachePostElements();

    const feedContainer = getFeedContainer();
    if (!feedContainer) {
      hideReorderOverlay();
      return { success: false, reorderedCount: 0, message: 'Feed container not found' };
    }

    updateReorderOverlay('Step 3: Reordering', `${sortedUrns.length} posts`, 'Applying your sort order...');

    const allChildren = Array.from(feedContainer.children);
    const postContainers: Map<string, Element> = new Map();
    const otherElements: Element[] = [];
    const sortedUrnSet = new Set(sortedUrns);

    allChildren.forEach((child) => {
      const postElement =
        child.querySelector('[data-id^="urn:li:activity:"], [data-urn^="urn:li:activity:"]') ||
        (child.getAttribute('data-id')?.includes('activity:') ? child : null);

      if (postElement) {
        const urn = postElement.getAttribute('data-id') || postElement.getAttribute('data-urn');
        const activityMatch = urn?.match(/urn:li:activity:(\d+)/);
        if (activityMatch) {
          const normalizedUrn = `urn:li:activity:${activityMatch[1]}`;

          if (sortedUrnSet.has(normalizedUrn)) {
            postContainers.set(normalizedUrn, child);
          } else {
            const hasContent = child.querySelector('.feed-shared-update-v2, .update-components-actor, .feed-shared-text');
            const isOccludableHint = child.querySelector('.occludable-update-hint');
            const isEmpty = isOccludableHint && !hasContent;
            if (!isEmpty) {
              postContainers.set(normalizedUrn, child);
            }
          }
        }
      } else {
        const hasEmptyPlaceholder =
          child.querySelector('.occludable-update-hint:empty') ||
          (child.querySelector('.occludable-update') && !child.querySelector('.feed-shared-update-v2'));

        if (!child.classList.contains('feed-skip-link__container') && !hasEmptyPlaceholder) {
          otherElements.push(child);
        }
      }
    });

    if (isProfile && profileCollected.size > 0) {
      profileCollected.forEach((element, urn) => {
        if (!postContainers.has(urn)) {
          postContainers.set(urn, element);
        }
      });
    }


    if (postContainers.size === 0) {
      hideReorderOverlay();
      return { success: false, reorderedCount: 0, message: 'No posts found in feed' };
    }

    const fragment = document.createDocumentFragment();
    let reorderedCount = 0;
    const processedUrns = new Set<string>();

    let createdCount = 0;
    const maxSorted = targetCount > 0 ? targetCount : sortedUrns.length;
    for (const urn of sortedUrns) {
      if (reorderedCount >= maxSorted) break;

      const container = postContainers.get(urn);

      if (container && !processedUrns.has(urn)) {
        const hotkeyEl = container.querySelector('[data-finite-scroll-hotkey-item]');
        if (hotkeyEl) {
          hotkeyEl.setAttribute('data-finite-scroll-hotkey-item', reorderedCount.toString());
        }
        fragment.appendChild(container);
        reorderedCount++;
        processedUrns.add(urn);
      } else if (!skipPlaceholders && postsDataMap.has(urn) && !processedUrns.has(urn)) {
        const postData = postsDataMap.get(urn)!;
        const card = createPostCard(postData, reorderedCount);
        fragment.appendChild(card);
        reorderedCount++;
        createdCount++;
        processedUrns.add(urn);
      }
    }

    if (createdCount > 0) {
    }

    const sortedPlacedCount = reorderedCount;

    postContainers.forEach((container, urn) => {
      if (!processedUrns.has(urn)) {
        const hasRealContent =
          container.querySelector('.feed-shared-update-v2__description') ||
          container.querySelector('.update-components-actor') ||
          container.querySelector('.feed-shared-text') ||
          container.querySelector('.update-components-text');

        if (hasRealContent) {
          const hotkeyEl = container.querySelector('[data-finite-scroll-hotkey-item]');
          if (hotkeyEl) {
            hotkeyEl.setAttribute('data-finite-scroll-hotkey-item', reorderedCount.toString());
          }
          fragment.appendChild(container);
          reorderedCount++;
        }
      }
    });

    while (feedContainer.firstChild) {
      feedContainer.removeChild(feedContainer.firstChild);
    }

    feedContainer.appendChild(fragment);

    otherElements.forEach((el) => {
      feedContainer.appendChild(el);
    });

    isReordered = true;
    hideReorderOverlay();

    window.scrollTo({ top: 0, behavior: 'auto' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    window.scrollTo({ top: 1, behavior: 'auto' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    window.scrollTo({ top: 0, behavior: 'auto' });
    await new Promise((resolve) => setTimeout(resolve, 400));


    showReorderNotification(sortedPlacedCount);

    return { success: true, reorderedCount: sortedPlacedCount, message: `Successfully reordered ${sortedPlacedCount} posts` };
  } catch (error) {
    hideReorderOverlay();
    return { success: false, reorderedCount: 0, message: (error as Error).message || 'Unknown error' };
  } finally {
    isReorderInProgress = false;
  }
}

function showReorderNotification(count: number): void {
  const notification = document.createElement('div');
  notification.id = 'linkedin-analyzer-notification';
  notification.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: linear-gradient(135deg, #034C9D 0%, #0066CC 100%);
    color: white;
    padding: 16px 32px;
    border-radius: 12px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 16px;
    font-weight: 600;
    box-shadow: 0 8px 30px rgba(3, 76, 157, 0.4);
    z-index: 999999;
    display: flex;
    align-items: center;
    gap: 12px;
    animation: slideDown 0.3s ease;
  `;

  notification.innerHTML = `
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M9 12l2 2 4-4"/>
      <circle cx="12" cy="12" r="10"/>
    </svg>
    <span>Feed reordered: ${count} posts sorted</span>
  `;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes slideDown {
      from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
      to { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.style.animation = 'slideDown 0.3s ease reverse';
    setTimeout(() => notification.remove(), 300);
  }, 4000);
}

function restoreOriginalOrder(): { success: boolean; message: string } {
  if (!isReordered) {
    return { success: false, message: 'Feed is not reordered' };
  }

  window.location.reload();
  return { success: true, message: 'Restoring original order...' };
}

function parsePostElement(postEl: Element): PostData | null {
  try {
    const activityUrn = postEl.getAttribute('data-urn') || postEl.getAttribute('data-id') || '';
    if (!activityUrn) return null;

    const activityMatch = activityUrn.match(/activity:(\d+)/);
    if (!activityMatch) return null;

    let authorName = 'Unknown';
    const authorEl = postEl.querySelector('.update-components-actor__title span[dir="ltr"] span[aria-hidden="true"]');
    if (authorEl) {
      authorName = authorEl.textContent?.trim() || 'Unknown';
    }

    let text = '';
    const textEl = postEl.querySelector('.update-components-text span[dir="ltr"]');
    if (textEl) {
      text = textEl.textContent?.trim() || '';
    }

    const parseNumberWithSpaces = (text: string): number => {
      const cleaned = text.replace(/[\s\u00A0\u202F,]+/g, '');
      const num = parseInt(cleaned, 10);
      return isNaN(num) ? 0 : num;
    };

    const parseRelativeTimestamp = (): number | undefined => {
      const now = Date.now();
      const subDesc = postEl.querySelector('.update-components-actor__sub-description');
      if (!subDesc) return undefined;

      const ariaHiddenText =
        subDesc.querySelector('span[aria-hidden="true"]')?.textContent?.trim() ||
        subDesc.textContent?.trim() ||
        '';

      const visuallyHiddenText = subDesc.querySelector('.visually-hidden')?.textContent?.trim() || '';
      const source = `${ariaHiddenText} ${visuallyHiddenText}`.toLowerCase();
      if (!source) return undefined;

      const compactMatch = source.match(/\b(\d+)\s*(m|h|d|w|mo|y|yr|yrs)\b/);
      if (compactMatch) {
        const value = Number(compactMatch[1]);
        const unit = compactMatch[2];
        if (!Number.isFinite(value) || value < 0) return undefined;
        if (unit === 'm') return now - value * 60 * 1000;
        if (unit === 'h') return now - value * 60 * 60 * 1000;
        if (unit === 'd') return now - value * 24 * 60 * 60 * 1000;
        if (unit === 'w') return now - value * 7 * 24 * 60 * 60 * 1000;
        if (unit === 'mo') return now - value * 30 * 24 * 60 * 60 * 1000;
        if (unit === 'y' || unit === 'yr' || unit === 'yrs') return now - value * 365 * 24 * 60 * 60 * 1000;
      }

      const textMatch = source.match(
        /\b(\d+)\s*(minute|minutes|min|hour|hours|day|days|week|weeks|month|months|year|years)\b/
      );
      if (textMatch) {
        const value = Number(textMatch[1]);
        const unit = textMatch[2];
        if (!Number.isFinite(value) || value < 0) return undefined;
        if (unit.startsWith('min')) return now - value * 60 * 1000;
        if (unit.startsWith('hour')) return now - value * 60 * 60 * 1000;
        if (unit.startsWith('day')) return now - value * 24 * 60 * 60 * 1000;
        if (unit.startsWith('week')) return now - value * 7 * 24 * 60 * 60 * 1000;
        if (unit.startsWith('month')) return now - value * 30 * 24 * 60 * 60 * 1000;
        if (unit.startsWith('year')) return now - value * 365 * 24 * 60 * 60 * 1000;
      }

      return undefined;
    };

    const mainSocialActivity = postEl.querySelector('.update-v2-social-activity');
    const searchContainer = mainSocialActivity || postEl;

    const isInComments = (el: Element): boolean => {
      let parent = el.parentElement;
      while (parent && parent !== postEl) {
        if (parent.className?.includes('comments-')) return true;
        parent = parent.parentElement;
      }
      return false;
    };

    let numLikes = 0;
    const reactionsBtns = searchContainer.querySelectorAll('[data-reaction-details]');
    for (const reactionsBtn of reactionsBtns) {
      if (isInComments(reactionsBtn)) continue;
      const ariaLabel = reactionsBtn.getAttribute('aria-label') || '';
      const match = ariaLabel.match(/([\d\s\u00A0,]+)/);
      if (match) {
        numLikes = parseNumberWithSpaces(match[1]);
        break;
      }
    }

    if (numLikes === 0) {
      const likesCountEls = searchContainer.querySelectorAll('.social-details-social-counts__reactions-count');
      for (const likesCountEl of likesCountEls) {
        if (isInComments(likesCountEl)) continue;
        const likesText = likesCountEl.textContent?.trim() || '';
        numLikes = parseNumberWithSpaces(likesText);
        if (numLikes > 0) break;
      }
    }

    if (numLikes === 0) {
      const socialCountsContainers = searchContainer.querySelectorAll('.social-details-social-counts__reactions');
      for (const socialCountsContainer of socialCountsContainers) {
        if (isInComments(socialCountsContainer)) continue;
        const fullText = socialCountsContainer.textContent || '';
        const moreMatch = fullText.match(/(?:и еще|and)\s*([\d\s\u00A0,]+)/i);
        if (moreMatch) {
          const additionalCount = parseNumberWithSpaces(moreMatch[1]);
          if (additionalCount > 0) {
            numLikes = 1 + additionalCount;
            break;
          }
        }
      }
    }

    let numComments = 0;
    const commentsLinks = searchContainer.querySelectorAll('.social-details-social-counts__comments button');
    for (const commentsLink of commentsLinks) {
      if (isInComments(commentsLink)) continue;
      const ariaLabel = commentsLink.getAttribute('aria-label') || '';
      const match = ariaLabel.match(/([\d\s\u00A0,]+)/);
      if (match) {
        numComments = parseNumberWithSpaces(match[1]);
        break;
      }

      if (numComments === 0) {
        const text = commentsLink.textContent?.trim() || '';
        numComments = parseNumberWithSpaces(text);
        if (numComments > 0) break;
      }
    }

    if (numComments === 0) {
      const commentBtns = searchContainer.querySelectorAll(
        'button[aria-label*="комментар"], button[aria-label*="comment"]'
      );
      for (const commentBtn of commentBtns) {
        if (isInComments(commentBtn)) continue;
        const ariaLabel = commentBtn.getAttribute('aria-label') || '';
        if (ariaLabel.includes('к публикации') || ariaLabel.includes('to post') || ariaLabel.includes('comments on')) {
          const match = ariaLabel.match(/([\d\s\u00A0,]+)/);
          if (match) {
            numComments = parseNumberWithSpaces(match[1]);
            break;
          }
        }
      }
    }

    let numShares = 0;
    const allButtons = searchContainer.querySelectorAll('.social-details-social-counts button');
    for (const btn of allButtons) {
      if (isInComments(btn)) continue;
      const ariaLabel = btn.getAttribute('aria-label') || '';
      const btnText = btn.textContent?.toLowerCase() || '';

      const isRepostButton =
        ariaLabel.includes('репост') ||
        ariaLabel.includes('repost') ||
        btnText.includes('репост') ||
        btnText.includes('repost');

      if (isRepostButton) {
        const match = ariaLabel.match(/([\d\s\u00A0,]+)/);
        if (match) {
          numShares = parseNumberWithSpaces(match[1]);
        }

        if (numShares === 0) {
          const textMatch = btnText.match(/([\d\s\u00A0,]+)/);
          if (textMatch) {
            numShares = parseNumberWithSpaces(textMatch[1]);
          }
        }
        break;
      }
    }

    const isSponsored =
      activityUrn.includes('sponsored') ||
      !!postEl.querySelector('[data-ad-banner]') ||
      postEl.textContent?.toLowerCase().includes('promoted') ||
      postEl.textContent?.toLowerCase().includes('реклама');
    const timestamp = parseRelativeTimestamp();

    return {
      activityUrn: `urn:li:activity:${activityMatch[1]}`,
      authorName,
      authorUrn: '',
      text,
      timestamp,
      numLikes,
      numComments,
      numShares,
      isSponsored,
    };
  } catch (e) {
    return null;
  }
}

function syncPostsWithDOM(): void {
  const postElements = document.querySelectorAll('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]');
  const domUpdates: PostData[] = [];

  postElements.forEach((postEl) => {
    const post = parsePostElement(postEl);
    if (post && (post.numLikes > 0 || post.numComments > 0 || post.numShares > 0)) {
      domUpdates.push({
        activityUrn: post.activityUrn,
        numLikes: post.numLikes,
        numComments: post.numComments,
        numShares: post.numShares,
        authorName: post.authorName,
      });
    }
  });

  if (domUpdates.length > 0) {
    chrome.runtime.sendMessage({
      type: 'SYNC_DOM_METRICS',
      updates: domUpdates,
    });
  }
}

function collectPostsFromDOM(): Promise<number> {
  return new Promise((resolve) => {
    const postElements = document.querySelectorAll('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]');
    const posts: PostData[] = [];

    postElements.forEach((postEl) => {
      const post = parsePostElement(postEl);
      if (post) {
        posts.push(post);
      }
    });

    if (posts.length > 0) {
      chrome.runtime.sendMessage(
        {
          type: 'DOM_POSTS',
          posts: posts,
        },
        () => {
          chrome.runtime.sendMessage({ type: 'GET_COLLECTION_STATE' }, (state) => {
            resolve(state?.currentCount || posts.length);
          });
        }
      );
    } else {
      resolve(0);
    }
  });
}

function initializeAfterLoad() {
  chrome.storage.local.get(['qp_pending'], (result) => {
    const pending = result.qp_pending;

    if (pending && pending.sortType && pending.count && Date.now() - pending.ts < 30000) {
      return;
    }


    chrome.runtime.sendMessage({ type: 'GET_COLLECTION_STATE' }, (response) => {
      if (qp_isActive) return;

      const hasValidTarget = response?.targetCount === 'all' || response?.targetCount > 0;
      if (response?.isCollecting && hasValidTarget) {
        popupCollectionActive = true;
        autoSortDone = false;
        showOverlay(response.currentCount, response.targetCount);
        setTimeout(() => {
          startAutoScroll();
        }, 2000);
      }
    });
  });
}

if (document.readyState === 'complete') {
  setTimeout(initializeAfterLoad, 1000);
} else {
  window.addEventListener('load', () => {
    setTimeout(initializeAfterLoad, 1000);
  });
}

window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'LINKEDIN_FEED_DATA_FROM_PAGE') {
    chrome.runtime
      .sendMessage({
        type: 'LINKEDIN_FEED_DATA',
        data: event.data.data,
        url: event.data.url,
        feedType: event.data.feedType,
        timestamp: event.data.timestamp,
      })
      .then(() => {
        if (popupCollectionActive) {
          updateOverlayCount();
          checkIfComplete();
        }
      })
      .catch((e) => console.log('[LinkedIn Analyzer] Error:', e));
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'START_AUTO_SCROLL') {
    popupCollectionActive = true;
    autoSortDone = false;
    startAutoScroll();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'STOP_AUTO_SCROLL') {
    stopAutoScroll();

    if (reorderFallbackTimeout) clearTimeout(reorderFallbackTimeout);

    if (!autoSortDone && !isReordered && !isReorderInProgress && popupCollectionActive) {
      showReorderOverlay('Preparing', 'Sorting posts...', 'Please wait');
    }

    reorderFallbackTimeout = setTimeout(() => {
      reorderFallbackTimeout = null;
      if (!autoSortDone && !isReordered && !isReorderInProgress && popupCollectionActive) {
        popupCollectionActive = false;
        autoSortDone = true;
        chrome.runtime.sendMessage({ type: 'GET_COLLECTION_STATE' }, (response) => {
          if (response) {
            autoSortFromContentScript(response.sortType || 'likes', response.requestedCount || 0, response.collectAll || false);
          }
        });
      }
    }, 1000);

    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'REORDER_FEED') {
    if (reorderFallbackTimeout) {
      clearTimeout(reorderFallbackTimeout);
      reorderFallbackTimeout = null;
    }
    popupCollectionActive = false;
    autoSortDone = true;

    if (isReordered || isReorderInProgress) {
      chrome.storage.local.get(['exportData'], (result) => {
        const count = result.exportData?.count || 0;
        sendResponse({ success: true, reorderedCount: count, message: 'Already sorted' });
      });
      return true;
    }

    const postsData: PostData[] = message.postsData || [];
    const sortedUrns: string[] = message.sortedUrns || postsData.map((p) => p.activityUrn);
    const targetCount: number = message.targetCount || 0;

    if (isProfileActivityPage()) {
      const sortType = message.sortType || 'likes';
      collectProfilePostsFromDOM(targetCount > 0 ? targetCount : 50)
        .then(({ posts: domPosts, elements }) => {
          const apiMap = new Map<string, PostData>();
          postsData.forEach((p) => { if (p.activityUrn) apiMap.set(p.activityUrn, p); });

          const merged: PostData[] = [];
          domPosts.forEach((domPost, urn) => {
            const apiPost = apiMap.get(urn);
            merged.push({
              activityUrn: urn,
              authorName: (apiPost?.authorName && apiPost.authorName !== 'Unknown') ? apiPost.authorName : domPost.authorName,
              text: apiPost?.text || domPost.text || '',
              numLikes: Math.max(apiPost?.numLikes || 0, domPost.numLikes || 0),
              numComments: Math.max(apiPost?.numComments || 0, domPost.numComments || 0),
              numShares: Math.max(apiPost?.numShares || 0, domPost.numShares || 0),
            });
          });

          const valid = merged.filter((p) => p.authorName !== 'Unknown' || p.numLikes > 0 || p.numComments > 0);
          const sorted = sortPosts(valid, sortType) as unknown as PostData[];
          const trimmed = targetCount > 0 ? sorted.slice(0, targetCount) : sorted;
          const finalUrns = trimmed.map((p) => p.activityUrn);

          return reorderFeedPosts(finalUrns, trimmed, true, targetCount, elements);
        })
        .then((result) => {
          chrome.runtime.sendMessage({ type: 'STOP_COLLECTION' });
          sendResponse(result);
        })
        .catch((error) => {
          sendResponse({ success: false, reorderedCount: 0, message: error.message });
        });
    } else {
      reorderFeedPosts(sortedUrns, postsData, true, targetCount)
        .then((result) => {
          chrome.runtime.sendMessage({ type: 'STOP_COLLECTION' });
          sendResponse(result);
        })
        .catch((error) => {
          sendResponse({ success: false, reorderedCount: 0, message: error.message });
        });
    }
    return true;
  }

  if (message.type === 'RESTORE_FEED') {
    const result = restoreOriginalOrder();
    sendResponse(result);
    return true;
  }

  if (message.type === 'CACHE_POSTS') {
    cachePostElements();
    sendResponse({ success: true, cachedCount: domElementsCache.size });
    return true;
  }

  return false;
});

function showOverlay(currentCount: number = 0, targetCount: number | 'all' = 0) {

  if (overlayElement) {
    return;
  }

  overlayElement = document.createElement('div');
  overlayElement.id = 'linkedin-analyzer-overlay';
  overlayElement.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.75);
    z-index: 999999;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  const card = document.createElement('div');
  card.style.cssText = `
    background: white;
    padding: 40px 60px;
    border-radius: 16px;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
  `;

  const safeCount = currentCount ?? 0;
  const countText = targetCount === 'all' ? `${safeCount} Posts` : `${safeCount} / ${targetCount ?? 0} Posts`;
  const subText = targetCount === 'all' ? 'collecting all posts...' : 'collecting data...';

  const stopBtnHtml = targetCount === 'all' ? `
    <button id="la-overlay-stop-btn" style="
      margin-top: 16px;
      padding: 10px 28px;
      background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
      color: white;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 0 2px 8px rgba(220, 38, 38, 0.3);
    ">Stop & Sort Now</button>
  ` : '';

  card.innerHTML = `
    <div style="
      width: 50px;
      height: 50px;
      border: 4px solid #e5e7eb;
      border-top-color: #034C9D;
      border-radius: 50%;
      margin: 0 auto 20px;
      animation: la-spin 1s linear infinite;
    "></div>
    <div id="la-overlay-count" style="
      font-size: 32px;
      font-weight: 700;
      color: #034C9D;
      margin-bottom: 8px;
    ">${countText}</div>
    <div style="
      font-size: 16px;
      color: #6b7280;
      margin-bottom: 4px;
    ">${subText}</div>
    <div style="
      font-size: 14px;
      color: #9ca3af;
    ">don't scroll manually</div>
    ${stopBtnHtml}
  `;

  const style = document.createElement('style');
  style.textContent = `
    @keyframes la-spin {
      to { transform: rotate(360deg); }
    }
  `;

  overlayElement.appendChild(card);
  overlayElement.appendChild(style);
  document.body.appendChild(overlayElement);

  if (targetCount === 'all') {
    const stopBtn = document.getElementById('la-overlay-stop-btn');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        stopBtn.textContent = 'Stopping...';
        stopBtn.style.opacity = '0.6';
        stopBtn.style.pointerEvents = 'none';
        stopAutoScroll();
        popupCollectionActive = false;
        autoSortDone = true;
        chrome.runtime.sendMessage({ type: 'GET_COLLECTION_STATE' }, (response) => {
          if (response) {
            autoSortFromContentScript(response.sortType || 'likes', response.requestedCount || 0, true);
          }
        });
      });
    }
  }

}

function updateOverlayText(currentCount: number, targetCount: number | 'all') {
  const countEl = document.getElementById('la-overlay-count');
  if (countEl) {
    const safeCount = currentCount ?? 0;
    if (targetCount === 'all') {
      countEl.textContent = `${safeCount} Posts`;
    } else {
      countEl.textContent = `${safeCount} / ${targetCount ?? 0} Posts`;
    }
  }
}

function updateOverlayCount() {
  chrome.runtime.sendMessage({ type: 'GET_COLLECTION_STATE' }, (response) => {
    if (response) {
      updateOverlayText(response.currentCount, response.targetCount);
    }
  });
}

function hideOverlay() {
  const el = document.getElementById('linkedin-analyzer-overlay');
  if (el) {
    el.remove();
  }
  overlayElement = null;
}

function waitForFeedToLoad(): Promise<void> {
  return new Promise((resolve) => {
    let attempts = 0;
    const maxAttempts = 20;

    const check = () => {
      attempts++;
      const feedContainer = document.querySelector('.scaffold-finite-scroll, [data-finite-scroll-hotkey-context]');
      const pageHeight = document.body.scrollHeight;
      const hasContent = pageHeight > 1500;


      if ((feedContainer && hasContent) || attempts >= maxAttempts) {
        resolve();
      } else {
        setTimeout(check, 500);
      }
    };

    check();
  });
}

async function startAutoScroll() {
  if (isAutoScrolling) {
    return;
  }


  const state = await new Promise<LinkedInEntity>((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_COLLECTION_STATE' }, resolve);
  });

  if (state) {
    currentCollectionMode = state.collectionMode || 'precision';
    showOverlay(state.currentCount, state.targetCount);
  }

  await waitForFeedToLoad();

  isAutoScrolling = true;
  lastScrollHeight = 0;
  noChangeCount = 0;
  noNewPostsCount = 0;
  lastPostCount = 0;
  buttonAttempts = 0;

  if (currentCollectionMode === 'precision') {
    collectPostsFromDOM();
  }

  checkInterval = setInterval(() => {
    if (!isAutoScrolling) {
      if (checkInterval) clearInterval(checkInterval);
      return;
    }
    updateOverlayCount();
    checkIfComplete();

    if (currentCollectionMode === 'lite') {
      return;
    }

    chrome.runtime.sendMessage({ type: 'GET_COLLECTION_STATE' }, (response) => {
      if (response && response.currentCount > 0) {
        syncPostsWithDOM();
      } else if (currentCollectionMode === 'precision') {
        collectPostsFromDOM();
      }
    });
  }, CHECK_INTERVAL);

  doScroll();
}

function getScrollContainer(): Element | null {
  const selectors = ['.scaffold-layout__main', '.scaffold-finite-scroll__content', '.core-rail', 'main'];

  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el && el.scrollHeight > el.clientHeight) {
      return el;
    }
  }
  return null;
}

function doScroll() {
  if (!isAutoScrolling) {
    return;
  }

  const scrollContainer = getScrollContainer();
  const currentScrollHeight = scrollContainer?.scrollHeight || document.body.scrollHeight;
  const currentScrollTop = scrollContainer?.scrollTop || window.scrollY || 0;


  try {
    if (scrollContainer) {
      scrollContainer.scrollTop = currentScrollHeight;
    }
    window.scrollTo({ top: currentScrollHeight, behavior: 'auto' });
    document.documentElement.scrollTop = currentScrollHeight;
    document.body.scrollTop = currentScrollHeight;
  } catch (e) {
  }

  if (currentCollectionMode !== 'lite') {
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'GET_COLLECTION_STATE' }, (response) => {
        if (response && response.currentCount > 0) {
          syncPostsWithDOM();
        } else if (currentCollectionMode === 'precision') {
          collectPostsFromDOM();
        }
      });
    }, 1000);
  }

  if (currentScrollHeight === lastScrollHeight) {
    noChangeCount++;

    if (noChangeCount >= MAX_NO_CHANGE) {
      tryClickLoadMoreButton();
    }
  } else {
    noChangeCount = 0;
    lastScrollHeight = currentScrollHeight;
  }

  scrollTimeout = setTimeout(() => {
    doScroll();
  }, SCROLL_DELAY);
}

function tryClickLoadMoreButton() {
  const clicked = clickLoadMoreButton();
  if (clicked) {
    noChangeCount = 0;
    buttonAttempts++;

    if (buttonAttempts >= MAX_BUTTON_ATTEMPTS) {
    }
  } else {
  }
}

function clickLoadMoreButton(): boolean {
  const feedArea = document.querySelector('.scaffold-layout__main, .core-rail, main') || document;
  const buttons = feedArea.querySelectorAll('button');

  for (const btn of buttons) {
    const text = btn.textContent?.toLowerCase().trim() || '';
    const isVisible = (btn as HTMLElement).offsetParent !== null;
    if (!isVisible) continue;

    if (btn.closest('.global-nav, .global-nav__content, nav, header')) continue;

    if (btn.classList.contains('scaffold-finite-scroll__load-button')) {
      btn.click();
      return true;
    }

    const isRussianFeedButton =
      text.includes('показать') &&
      text.includes('результат') &&
      (text.includes('ленте') || text.includes('ленты') || text.includes('обновлен'));

    if (isRussianFeedButton) {
      btn.click();
      return true;
    }

    if (text.includes('показать') && text.includes('больше')) {
      btn.click();
      return true;
    }

    if (text.includes('show') && text.includes('more') && (text.includes('feed') || text.includes('result') || text.includes('update'))) {
      btn.click();
      return true;
    }

    if ((text.includes('show') || text.includes('see')) && text.includes('new') && text.includes('post')) {
      btn.click();
      return true;
    }
  }

  return false;
}

function checkIfComplete() {
  if (!popupCollectionActive) return;

  chrome.runtime.sendMessage({ type: 'GET_COLLECTION_STATE' }, (response) => {
    if (response) {

      if (!response.isCollecting) {
        stopAutoScroll();
        popupCollectionActive = false;
        if (!autoSortDone) {
          autoSortDone = true;
          autoSortFromContentScript(response.sortType, response.requestedCount, response.collectAll);
        }
        return;
      }

      if (response.currentCount === lastPostCount) {
        noNewPostsCount++;

        if (noNewPostsCount >= 2 && noNewPostsCount < MAX_NO_NEW_POSTS) {
          tryClickLoadMoreButton();
        }

        if (response.collectAll || response.targetCount === 'all') {
          if (noNewPostsCount >= MAX_NO_NEW_POSTS) {
            chrome.runtime.sendMessage({ type: 'STOP_COLLECTION' });
            stopAutoScroll();
          }
        }
      } else {
        noNewPostsCount = 0;
        buttonAttempts = 0;
        lastPostCount = response.currentCount;
      }
    }
  });
}

function stopAutoScroll() {
  isAutoScrolling = false;
  if (scrollTimeout) {
    clearTimeout(scrollTimeout);
    scrollTimeout = null;
  }
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
  hideOverlay();
}

async function collectProfilePostsFromDOM(targetCount: number): Promise<{
  posts: Map<string, PostData>;
  elements: Map<string, Element>;
}> {
  const posts = new Map<string, PostData>();
  const elements = new Map<string, Element>();

  const collectVisible = () => {
    document.querySelectorAll('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]').forEach((el) => {
      const urn =
        el.getAttribute('data-urn') ||
        el.getAttribute('data-id') ||
        el.closest('[data-id]')?.getAttribute('data-id');
      if (!urn || !urn.includes('activity:')) return;

      const post = parsePostElement(el);
      if (post && post.activityUrn) {
        const existing = posts.get(post.activityUrn);
        if (
          !existing ||
          existing.authorName === 'Unknown' ||
          (existing.numLikes === 0 && existing.numComments === 0 && post.numLikes > 0) ||
          (existing.text === '' && post.text !== '') ||
          (!existing.timestamp && !!post.timestamp)
        ) {
          posts.set(post.activityUrn, {
            activityUrn: post.activityUrn,
            authorName: post.authorName || 'Unknown',
            text: post.text || '',
            timestamp: post.timestamp,
            numLikes: post.numLikes || 0,
            numComments: post.numComments || 0,
            numShares: post.numShares || 0,
          });
        }
        if (!elements.has(post.activityUrn)) {
          const wrapper = el.closest('li') || el.closest('[data-finite-scroll-hotkey-item]') || el;
          elements.set(post.activityUrn, wrapper);
        }
      }
    });

    document.querySelectorAll('.scaffold-finite-scroll__content li').forEach((li) => {
      const inner = li.querySelector('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]');
      if (inner) return;

      const urnEl = li.querySelector('[data-id]');
      const urn = urnEl?.getAttribute('data-id') || '';
      if (!urn.includes('activity:')) return;

      const post = parsePostElement(urnEl!);
      if (post && post.activityUrn) {
        if (!posts.has(post.activityUrn)) {
          posts.set(post.activityUrn, {
            activityUrn: post.activityUrn,
            authorName: post.authorName || 'Unknown',
            text: post.text || '',
            numLikes: post.numLikes || 0,
            numComments: post.numComments || 0,
            numShares: post.numShares || 0,
          });
        }
        if (!elements.has(post.activityUrn)) {
          elements.set(post.activityUrn, li);
        }
      }
    });
  };

  const scrollTo = (pos: number) => {
    const scrollContainer = getScrollContainer();
    try {
      if (scrollContainer) (scrollContainer as HTMLElement).scrollTop = pos;
      window.scrollTo({ top: pos, behavior: 'auto' });
      document.documentElement.scrollTop = pos;
      document.body.scrollTop = pos;
    } catch (e) {
    }
  };

  const tryClickLoadMore = (): boolean => {
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase() || '';
      const isVisible = (btn as HTMLElement).offsetParent !== null;
      if (!isVisible) continue;

      if (btn.classList.contains('scaffold-finite-scroll__load-button')) {
        btn.click();
        return true;
      }
      if (text.includes('показать') && (text.includes('результат') || text.includes('больше'))) {
        btn.click();
        return true;
      }
      if ((text.includes('show') || text.includes('see')) && (text.includes('new') || text.includes('more'))) {
        btn.click();
        return true;
      }
      if (text.includes('weitere') || text.includes('mehr')) {
        btn.click();
        return true;
      }
    }
    return false;
  };

  stopAndSortRequested = false;
  const isCollectAll = targetCount <= 0;
  showReorderOverlay('Collecting', 'Scanning posts...', 'Please wait', isCollectAll);

  scrollTo(0);
  await new Promise((resolve) => setTimeout(resolve, 500));
  collectVisible();

  const needed = targetCount > 0 ? targetCount + 5 : 100;
  const scrollStep = 800;
  let lastPostCount = posts.size;
  let noProgressCount = 0;
  let lastScrollHeight = 0;
  let noScrollChangeCount = 0;
  let loadMoreAttempts = 0;

  for (let attempt = 0; attempt < 60; attempt++) {
    if (posts.size >= needed) break;
    if (stopAndSortRequested) {
      break;
    }

    collectVisible();

    const scrollContainer = getScrollContainer();
    const currentScrollHeight = scrollContainer?.scrollHeight || document.body.scrollHeight;
    const currentScroll = window.scrollY || document.documentElement.scrollTop;
    const nextScroll = Math.min(currentScroll + scrollStep, currentScrollHeight);

    scrollTo(nextScroll);

    await new Promise((resolve) => setTimeout(resolve, 600));
    collectVisible();
    await new Promise((resolve) => setTimeout(resolve, 600));
    collectVisible();

    const displayCount = targetCount > 0 ? Math.min(posts.size, targetCount) : posts.size;
    const displayTarget = targetCount > 0 ? targetCount : 'all';
    updateReorderOverlay(undefined, `${displayCount} / ${displayTarget} posts`, 'Scanning...');

    if (currentScrollHeight === lastScrollHeight) {
      noScrollChangeCount++;
      if (noScrollChangeCount >= 4 && loadMoreAttempts < 3) {
        const clicked = tryClickLoadMore();
        if (clicked) {
          loadMoreAttempts++;
          noScrollChangeCount = 0;
          await new Promise((resolve) => setTimeout(resolve, 2000));
          collectVisible();
          continue;
        }
      }
    } else {
      noScrollChangeCount = 0;
      lastScrollHeight = currentScrollHeight;
    }

    if (posts.size > lastPostCount) {
      noProgressCount = 0;
      lastPostCount = posts.size;
    } else {
      noProgressCount++;
    }

    if (nextScroll >= currentScrollHeight - 100) {
      collectVisible();

      if (posts.size < needed && loadMoreAttempts < 3 && !stopAndSortRequested) {
        const clicked = tryClickLoadMore();
        if (clicked) {
          loadMoreAttempts++;
          noScrollChangeCount = 0;
          await new Promise((resolve) => setTimeout(resolve, 2000));
          collectVisible();
          scrollTo(0);
          await new Promise((resolve) => setTimeout(resolve, 500));
          collectVisible();
          continue;
        }
      }

      if (posts.size < needed && noProgressCount < 8 && !stopAndSortRequested) {
        scrollTo(0);
        await new Promise((resolve) => setTimeout(resolve, 500));
        collectVisible();
      } else {
        break;
      }
    }

    if (noProgressCount >= 8) {
      break;
    }
  }

  scrollTo(0);
  await new Promise((resolve) => setTimeout(resolve, 500));
  hideReorderOverlay();

  return { posts, elements };
}

async function autoSortFromContentScript(sortType: string, requestedCount: number, collectAll: boolean): Promise<void> {
  if (isReorderInProgress || isReordered) {
    return;
  }


  try {
    if (isProfileActivityPage()) {
      const targetCount = collectAll ? 0 : (requestedCount > 0 ? requestedCount : 0);
      const { posts: domPosts, elements } = await collectProfilePostsFromDOM(targetCount > 0 ? targetCount : 50);


      const apiResponse = await new Promise<{ posts: LinkedInEntity[] }>((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_POSTS' }, (res) => resolve(res));
      });

      const apiPostsMap = new Map<string, LinkedInEntity>();
      if (apiResponse?.posts) {
        apiResponse.posts.forEach((p) => {
          if (p.activityUrn) apiPostsMap.set(p.activityUrn, p);
        });
      }

      const mergedPosts: PostData[] = [];
      domPosts.forEach((domPost, urn) => {
        const apiPost = apiPostsMap.get(urn);
        mergedPosts.push({
          activityUrn: urn,
          authorName: (apiPost?.authorName && apiPost.authorName !== 'Unknown') ? apiPost.authorName : domPost.authorName,
          text: apiPost?.text || domPost.text || '',
          timestamp: domPost.timestamp || apiPost?.timestamp,
          numLikes: Math.max(apiPost?.numLikes || 0, domPost.numLikes || 0),
          numComments: Math.max(apiPost?.numComments || 0, domPost.numComments || 0),
          numShares: Math.max(apiPost?.numShares || 0, domPost.numShares || 0),
        });
      });

      const validPosts = mergedPosts.filter(
        (p) => p.authorName !== 'Unknown' || p.numLikes > 0 || p.numComments > 0
      );

      if (validPosts.length === 0) {
        return;
      }

      const sorted = sortPosts(validPosts, sortType) as unknown as PostData[];
      const trimmed = collectAll ? sorted : sorted.slice(0, targetCount || sorted.length);
      const sortedUrns = trimmed.map((p) => p.activityUrn);


      const result = await reorderFeedPosts(sortedUrns, trimmed, true, targetCount, elements);

      chrome.storage.local.set({
        exportData: {
          posts: trimmed,
          count: result.reorderedCount,
          filter: sortType,
        },
      });

      chrome.runtime.sendMessage({ type: 'STOP_COLLECTION' });
    } else {
      const response = await new Promise<{ posts: LinkedInEntity[] }>((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_POSTS' }, (res) => resolve(res));
      });

      if (!response?.posts || response.posts.length === 0) {
        return;
      }

      const sorted = sortPosts([...response.posts], sortType);

      const sortedUrns = sorted.map((p: LinkedInEntity) => p.activityUrn);
      const postsData: PostData[] = sorted.map((p: LinkedInEntity) => ({
        activityUrn: p.activityUrn,
        authorName: p.authorName,
        text: p.text,
        numLikes: p.numLikes,
        numComments: p.numComments,
        numShares: p.numShares,
      }));

      const targetCount = collectAll ? 0 : (requestedCount > 0 ? requestedCount : 0);


      const result = await reorderFeedPosts(sortedUrns, postsData, true, targetCount);

      const trimmedData = collectAll ? postsData : postsData.slice(0, targetCount || postsData.length);
      chrome.storage.local.set({
        exportData: {
          posts: trimmedData,
          count: result.reorderedCount,
          filter: sortType,
        },
      });

      chrome.runtime.sendMessage({ type: 'STOP_COLLECTION' });
    }
  } catch (error) {
  }
}

function injectSortControls(): void {
  if (document.getElementById('linkedin-analyzer-sort-controls')) return;

  let anchorElement: Element | null = null;

  if (isProfileActivityPage()) {
    anchorElement = findProfileAnchor();
  } else {
    anchorElement = document.querySelector('.feed-sort-toggle-dsa__wrapper');

    if (!anchorElement) {
      const hr = document.querySelector('hr.feed-index-sort-border');
      if (hr) {
        anchorElement = hr.closest('.artdeco-dropdown') || hr.closest('.mb2');
      }
    }

    if (!anchorElement) {
      const buttons = document.querySelectorAll('button.artdeco-dropdown__trigger');
      for (const btn of buttons) {
        const text = btn.textContent || '';
        if (text.includes('Сортировать') || text.includes('Sort by') || text.includes('Sortieren')) {
          anchorElement = btn.closest('.artdeco-dropdown');
          break;
        }
      }
    }

    if (!anchorElement) {
      anchorElement = document.querySelector('.share-box-feed-entry__closed-share-box');
    }

    if (!anchorElement) {
      const sortDropdown = document.querySelector('.mb2.artdeco-dropdown');
      if (sortDropdown && (sortDropdown.textContent?.includes('Sort by') || sortDropdown.textContent?.includes('Сортировать') || sortDropdown.querySelector('hr.feed-index-sort-border'))) {
        anchorElement = sortDropdown;
      }
    }
  }

  if (!anchorElement) {
    setTimeout(injectSortControls, 2000);
    return;
  }


  chrome.storage.local.get(['userPlan'], (result) => {
    qp_userPlan = result.userPlan || 'free';
    renderQuickPanel(anchorElement!);
  });
}

function renderQuickPanel(feedToggleWrapper: Element): void {
  const isFree = qp_userPlan === 'free';
  const isProfile = isProfileActivityPage();
  const isRazvanAllActivityPage = /^\/in\/razvanpop\/recent-activity\/all\/?$/.test(window.location.pathname);
  const panelMargin = isRazvanAllActivityPage ? '8px 24px' : '8px 0';
  const countOptions: Array<number | 'all'> = isProfile ? [25, 50, 100, 250, 'all'] : [25, 50, 100, 250, 500];
  const countButtonsHtml = countOptions
    .map((value) => {
      const isLocked = isFree && value !== 25;
      const label = value === 'all' ? 'All' : String(value);
      const lockedLabel = isLocked ? ' \uD83D\uDD12' : '';
      const isActive = value === 25 ? ' active' : '';
      const widthClass = value === 'all' || value === 500 ? ' la-count-btn--wide' : '';
      return `<button class="la-count-btn${isActive}${isLocked ? ' locked' : ''}${widthClass}" data-count="${value}">${label}${lockedLabel}</button>`;
    })
    .join('');
  const datePresetOptionsHtml = ([
    ['week', 'Posts from 1 Week Back'],
    ['month1', 'Posts from 1 Month Back'],
    ['month3', 'Posts from 3 Months Back'],
    ['month6', 'Posts from 6 Months Back'],
    ['year1', 'Posts from 1 Year Back'],
    ['all', 'All Posts'],
  ] as Array<[QPDatePreset, string]>)
    .map(([value, label]) => {
      const locked = isFree && value !== 'week';
      return `<button type="button" class="la-date-option${value === 'week' ? ' active' : ''}${locked ? ' locked' : ''}" data-value="${value}" ${locked ? 'data-locked="1"' : ''}>${label}${locked ? ' 🔒' : ''}</button>`;
    })
    .join('');

  const sortControls = document.createElement('div');
  sortControls.id = 'linkedin-analyzer-sort-controls';
  sortControls.innerHTML = `
    <style>
      #linkedin-analyzer-sort-controls {
        --la-border: #cfd8e3;
        --la-bg: #ffffff;
        --la-card: #f6f8fb;
        --la-blue: #1f66b3;
        --la-blue-strong: #155a9f;
        --la-text: #3a424d;
        --la-subtext: #7a8796;
        --la-orange: #ea650e;
        margin: ${panelMargin};
        border: 1px solid var(--la-border);
        border-radius: 12px;
        background: var(--la-bg);
        box-shadow: 0 8px 20px rgba(9, 30, 66, 0.08);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        overflow: visible;
      }

      .la-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 12px;
        border-bottom: 1px solid var(--la-border);
      }

      .la-title {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .la-icon {
        width: 24px;
        height: 24px;
        color: var(--la-orange);
      }

      .la-title-text {
        font-size: 16px;
        line-height: 1.1;
        font-weight: 700;
        color: var(--la-orange);
      }

      .la-mode-switch {
        display: inline-flex;
        border: 1px solid var(--la-border);
        border-radius: 9px;
        overflow: hidden;
      }

      .la-mode-btn {
        border: 0;
        background: #fff;
        color: var(--la-text);
        font-size: 11px;
        line-height: 1;
        font-weight: 600;
        padding: 4px 12px;
        cursor: pointer;
      }

      .la-mode-btn + .la-mode-btn {
        border-left: 1px solid var(--la-border);
      }

      .la-mode-btn.active {
        background: #1361ae;
        color: #fff;
      }

      .la-mode-btn:not(.active):hover {
        background: #f4f8fc;
      }

      .la-body {
        padding: 10px 12px;
      }

      .la-section-title {
        font-size: 12px;
        line-height: 16px;
        font-weight: 600;
        color: var(--la-text);
        margin: 0 0 8px;
      }

      .la-config-card {
        border: 1px solid var(--la-border);
        border-radius: 12px;
        background: var(--la-card);
        padding: 10px 12px;
        margin-bottom: 10px;
      }

      .la-count-selector {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 8px;
      }

      .la-count-btn {
        width: 56px;
        height: 32px;
        border: 1px solid var(--la-border);
        border-radius: 8px;
        background: #fff;
        color: var(--la-text);
        font-size: 11px;
        line-height: 1;
        font-weight: 700;
        cursor: pointer;
        transition: background 0.18s ease, color 0.18s ease, border-color 0.18s ease;
      }

      .la-count-btn--wide {
        width: 64px;
      }

      .la-count-btn:hover {
        background: #eef4fb;
      }

      .la-count-btn.active {
        background: var(--la-blue);
        border-color: var(--la-blue);
        color: #fff;
      }

      .la-count-btn.locked {
        opacity: 0.55;
      }

      .la-count-btn.locked:hover {
        background: #fff4e8;
      }

      .la-custom-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .la-custom-label {
        font-size: 12px;
        line-height: 1;
        font-weight: 700;
        color: var(--la-text);
      }

      .la-custom-input-wrap {
        flex: 1;
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .la-custom-input {
        flex: 1 1 auto;
        width: 100%;
        display: block;
        height: 38px;
        border: 1px solid #cddbeb !important;
        border-radius: 8px !important;
        background: #fff !important;
        color: #111827;
        font-size: 14px;
        line-height: 1;
        font-weight: 600;
        padding: 0 12px !important;
        box-shadow: none !important;
        -webkit-appearance: none;
        appearance: none;
      }

      .la-custom-input:focus {
        outline: none;
        border-color: #034c9d !important;
        box-shadow: none !important;
      }

      .la-custom-max {
        font-size: 11px;
        line-height: 1;
        font-weight: 600;
        color: var(--la-subtext);
      }

      .la-config-panel.hidden {
        display: none;
      }

      .la-date-dropdown {
        position: relative;
      }

      .la-date-select {
        width: 100%;
        height: 38px;
        border: 1px solid #cddbeb;
        border-radius: 8px;
        background: #fff;
        color: #353b41;
        font-size: 12px;
        font-weight: 500;
        padding: 0 12px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        cursor: pointer;
      }

      .la-date-select.open,
      .la-date-select:hover {
        border-color: #cddbeb;
        box-shadow: none;
      }

      .la-date-select:focus-visible {
        outline: none;
      }

      .la-date-select svg {
        width: 16px;
        height: 16px;
        color: #6b7280;
      }

      .la-date-menu {
        display: none;
        position: absolute;
        top: calc(100% + 2px);
        left: 0;
        right: 0;
        background: #fff;
        border: 1px solid #cddbeb;
        border-radius: 10px;
        box-shadow: 0 8px 24px rgba(15, 23, 42, 0.12);
        padding: 6px;
        z-index: 1000001;
      }

      .la-date-menu.open {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .la-date-option {
        border: 0;
        background: #fff;
        color: #353b41;
        font-size: 12px;
        line-height: 16px;
        font-weight: 500;
        text-align: left;
        padding: 8px 10px;
        border-radius: 8px;
        cursor: pointer;
      }

      .la-date-option:hover,
      .la-date-option.active {
        background: #eef4fb;
        color: #1f66b3;
      }

      .la-date-option.locked {
        opacity: 0.65;
      }

      .la-date-custom-row {
        display: grid;
        grid-template-columns: auto 1fr auto 1fr;
        gap: 8px;
        align-items: center;
        margin-top: 8px;
      }

      .la-date-field {
        width: 100%;
        height: 28px;
        border: 1px solid #cddbeb;
        border-radius: 8px;
        background: #fff;
        color: #020817;
        font-size: 12px;
        font-weight: 500;
        padding: 0 8px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        cursor: pointer;
      }

      .la-date-field:hover {
        border-color: #cddbeb;
      }

      .la-date-field:focus-visible {
        outline: none;
      }

      .la-date-field span {
        white-space: nowrap;
      }

      .la-date-field svg {
        width: 14px;
        height: 14px;
        color: #6b7280;
        flex-shrink: 0;
      }

      .la-calendar-popover {
        position: absolute;
        width: 268px;
        background: #fff;
        border: 1px solid #cddbeb;
        border-radius: 12px;
        box-shadow: 0 12px 24px rgba(15, 23, 42, 0.14);
        padding: 8px;
        z-index: 1000002;
      }

      .la-cal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 6px;
      }

      .la-cal-title {
        font-size: 13px;
        font-weight: 700;
        color: #111827;
      }

      .la-cal-nav {
        width: 30px;
        height: 30px;
        border: 1px solid #dbe3ee;
        border-radius: 8px;
        background: #f8fafc;
        color: #6b7280;
        font-size: 22px;
        line-height: 1;
        cursor: pointer;
      }

      .la-cal-weekdays {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        margin-bottom: 4px;
      }

      .la-cal-weekdays span {
        text-align: center;
        font-size: 11px;
        font-weight: 600;
        color: #64748b;
        padding: 4px 0;
      }

      .la-cal-grid {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 2px;
      }

      .la-cal-day {
        height: 31px;
        border: 0;
        border-radius: 8px;
        background: #fff;
        color: #111827;
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
      }

      .la-cal-day:hover {
        background: #eef4fb;
      }

      .la-cal-day.outside {
        color: #9ca3af;
      }

      .la-cal-day.today {
        background: #f8fbff;
        box-shadow: inset 0 0 0 1px #dbe7f5;
      }

      .la-cal-day.future {
        color: #b8c0cc;
        background: #fafbfd;
        cursor: not-allowed;
      }

      .la-cal-day.selected {
        background: #1f66b3;
        color: #fff;
        box-shadow: none;
      }

      .la-cal-footer {
        display: flex;
        justify-content: space-between;
        margin-top: 6px;
      }

      .la-cal-action {
        border: 0;
        background: transparent;
        color: #1f66b3;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        padding: 4px 2px;
      }

      .la-date-sep {
        font-size: 12px;
        font-weight: 600;
        color: #6b7280;
      }

      .la-sort-row {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
      }

      .la-sort-btn {
        min-height: 65px;
        padding: 12px 0;
        border: 1px solid #e5e7eb;
        border-radius: 9px;
        background: #fff;
        color: #374151;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 3px;
      }

      .la-sort-btn:hover {
        background: #f0f9ff;
        border-color: #0077B5;
        color: #0077B5;
      }

      .la-sort-btn.active {
        background: linear-gradient(135deg, #0077B5 0%, #00A0DC 100%);
        color: #fff;
        border-color: transparent;
        box-shadow: 0 2px 8px rgba(0, 119, 181, 0.25);
      }

      .la-sort-btn.loading {
        opacity: 0.7;
        pointer-events: none;
        animation: la-loading 1.5s ease-in-out infinite;
      }
      
      @keyframes la-loading {
        0%, 100% { opacity: 0.7; }
        50% { opacity: 0.4; }
      }

      .la-sort-btn svg {
        width: 18px;
        height: 18px;
      }

      .la-sort-btn span {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 10px;
        line-height: 1;
        font-weight: 600;
      }

      .la-help-icon {
        width: 12px !important;
        height: 12px !important;
      }

      .la-engagement-tip {
        position: relative;
        display: inline-flex;
        align-items: center;
      }

      .la-engagement-tip .la-tip {
        position: absolute;
        bottom: calc(100% + 8px);
        left: 50%;
        transform: translateX(-50%);
        white-space: nowrap;
        background: #fff;
        border: 1px solid #d9e1ea;
        border-radius: 10px;
        padding: 8px 12px;
        color: #111827;
        font-size: 12px;
        font-weight: 600;
        box-shadow: 0 6px 20px rgba(15, 23, 42, 0.12);
        opacity: 0;
        pointer-events: none;
        z-index: 1000000;
      }

      .la-sort-btn[data-sort="engagement"]:hover .la-tip {
        opacity: 1;
      }

      .la-footer {
        margin-top: 8px;
        display: flex;
        align-items: center;
        gap: 0;
        width: 100%;
      }

      .la-restore-btn {
        padding: 8px 12px;
        font-size: 12px;
        font-weight: 500;
        border: 1px solid #fee2e2;
        border-radius: 8px;
        background: #fef2f2;
        color: #dc2626;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }

      .la-restore-btn:hover {
        background: #fee2e2;
        border-color: #fecaca;
      }

      .la-restore-btn svg {
        width: 14px;
        height: 14px;
      }

      .la-export-row {
        display: none;
        align-items: center;
        gap: 6px;
        width: 100%;
        flex: 1;
      }
      
      .la-export-wrapper {
        flex: 1;
        width: 100%;
        position: relative;
      }

      .la-export-trigger {
        width: 100%;
        padding: 8px 16px;
        font-size: 12px;
        font-weight: 500;
        border: 1px solid #dbeafe;
        border-radius: 8px;
        background: #eff6ff;
        color: #2563eb;
        cursor: pointer;
        transition: all 0.2s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
      }

      .la-export-trigger:hover {
        background: #dbeafe;
        border-color: #93c5fd;
      }

      .la-export-trigger svg {
        width: 14px;
        height: 14px;
      }

      .la-export-dropdown {
        display: none;
        position: absolute;
        bottom: calc(100% + 6px);
        left: 0;
        width: 100%;
        background: white;
        border: 1px solid #e5e7eb;
        border-radius: 12px;
        box-shadow: 0 8px 24px rgba(0,0,0,0.12), 0 2px 6px rgba(0,0,0,0.06);
        padding: 8px;
        z-index: 100;
        animation: la-dropdown-in 0.18s ease;
        gap: 6px;
      }

      .la-export-dropdown.open {
        display: flex;
        flex-direction: column;
      }

      @keyframes la-dropdown-in {
        from { opacity: 0; transform: translateY(6px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .la-export-option {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 10px 14px;
        border: 1px solid #e5e7eb;
        background: #fafafa;
        border-radius: 10px;
        font-size: 12px;
        font-weight: 500;
        color: #374151;
        cursor: pointer;
        transition: all 0.15s ease;
        font-family: inherit;
      }

      .la-export-option:hover {
        transform: translateY(-1px);
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      }

      .la-export-option--excel:hover {
        background: #f0fdf4;
        border-color: #86efac;
      }

      .la-export-option--csv:hover {
        background: #eff6ff;
        border-color: #93c5fd;
      }

      .la-export-option--json:hover {
        background: #fffbeb;
        border-color: #fcd34d;
      }

      .la-export-option-icon {
        width: 34px;
        height: 34px;
        border-radius: 8px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 11px;
        font-weight: 800;
        flex-shrink: 0;
        letter-spacing: -0.3px;
      }

      .la-export-option-icon--excel {
        background: #dcfce7;
        color: #16a34a;
        border: 1px solid #bbf7d0;
      }

      .la-export-option-icon--csv {
        background: #dbeafe;
        color: #2563eb;
        border: 1px solid #bfdbfe;
      }

      .la-export-option-icon--json {
        background: #fef3c7;
        color: #d97706;
        border: 1px solid #fde68a;
      }

      .la-export-option-text {
        display: flex;
        flex-direction: column;
        gap: 2px;
        text-align: left;
      }

      .la-export-option-text strong {
        font-size: 13px;
        font-weight: 600;
        color: #1a1a1a;
      }

      .la-export-option-text span {
        font-size: 11px;
        color: #9ca3af;
      }

      .la-status {
        display: none;
        align-items: center;
        justify-content: center;
        gap: 8px;
        padding: 8px;
        background: #f0f9ff;
        border-radius: 6px;
        font-size: 12px;
        color: #0077B5;
      }

      .la-status.visible {
        display: flex;
      }

      .la-spinner {
        width: 14px;
        height: 14px;
        border: 2px solid #e0f2fe;
        border-top-color: #0077B5;
        border-radius: 50%;
        animation: la-spin 0.8s linear infinite;
      }

      @keyframes la-spin {
        to { transform: rotate(360deg); }
      }

      @media (max-width: 900px) {
        #linkedin-analyzer-sort-controls .la-sort-row {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        #linkedin-analyzer-sort-controls .la-header {
          flex-wrap: wrap;
        }
      }

      #la-premium-modal-backdrop {
        position: fixed;
        top: 0; left: 0;
        width: 100vw; height: 100vh;
        background: rgba(0, 0, 0, 0.6);
        z-index: 999998;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      #la-premium-modal {
        background: white;
        border-radius: 16px;
        padding: 32px 28px;
        width: 400px;
        max-width: 90vw;
        position: relative;
        box-shadow: 0 20px 60px rgba(0,0,0,0.3);
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      }
      
      .la-pm-close {
        position: absolute; top: 12px; right: 14px;
        background: none; border: none;
        font-size: 20px; color: #9ca3af;
        cursor: pointer; padding: 4px; line-height: 1;
      }
      .la-pm-close:hover { color: #4b5563; }
      .la-pm-icon { font-size: 36px; text-align: center; margin-bottom: 8px; }
      .la-pm-title { font-size: 22px; font-weight: 700; color: #1a1a1a; text-align: center; margin-bottom: 4px; }
      .la-pm-subtitle { font-size: 14px; color: #6b7280; text-align: center; margin-bottom: 24px; }
      .la-pm-features { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }
      .la-pm-feature { display: flex; align-items: center; gap: 10px; padding: 8px 10px; background: #f0f7ff; border: 1px solid #cddbeb; border-radius: 8px; }
      .la-pm-feature-icon-wrap { width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; background: white; border: 1px solid #cddbeb; border-radius: 6px; flex-shrink: 0; }
      .la-pm-feature-icon { width: 18px; height: 18px; color: #034c9d; stroke-width: 1.5; }
      .la-pm-feature-text { display: flex; flex-direction: column; gap: 2px; }
      .la-pm-feature-text strong { font-size: 14px; font-weight: 600; color: #1a1a1a; }
      .la-pm-feature-text span { font-size: 12px; color: #6b7280; }
      .la-pm-cta {
        width: 100%; padding: 16px 24px;
        background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
        color: white; border: none; border-radius: 12px;
        font-size: 16px; font-weight: 700; cursor: pointer;
        transition: all 0.2s ease;
        box-shadow: 0 4px 16px rgba(245, 158, 11, 0.35);
      }
      .la-pm-cta:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(245, 158, 11, 0.5); }
      .la-pm-price { font-size: 13px; color: #9ca3af; text-align: center; margin-top: 12px; }
    </style>

    <div class="la-header">
      <div class="la-title">
        <svg class="la-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/>
        </svg>
        <span class="la-title-text">LinkedIn Analyzer</span>
      </div>
      ${
        isProfile
          ? `<div class="la-mode-switch">
              <button class="la-mode-btn active" data-mode="posts">Sort by Posts</button>
              <button class="la-mode-btn" data-mode="date">Sort by Date</button>
            </div>`
          : ''
      }
    </div>

    <div class="la-body">
      <div class="la-section-title">Sort by Posts</div>
      <div class="la-config-panel" id="la-posts-config">
        <div class="la-config-card">
          <div class="la-count-selector">
            ${countButtonsHtml}
          </div>
          <div class="la-custom-row">
            <span class="la-custom-label">Custom:</span>
            <div class="la-custom-input-wrap">
              <input id="la-custom-count" class="la-custom-input" type="number" min="1" max="2000" value="25" />
              ${isProfile ? '' : '<span class="la-custom-max">Max: 2000</span>'}
            </div>
          </div>
        </div>
      </div>

      <div class="la-config-panel hidden" id="la-date-config">
        <div class="la-config-card">
          <div class="la-date-dropdown">
            <button type="button" id="la-date-preset-trigger" class="la-date-select">
              <span id="la-date-preset-label">Posts from 1 Week Back</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="m6 9 6 6 6-6"></path>
              </svg>
            </button>
            <div id="la-date-preset-menu" class="la-date-menu">
              ${datePresetOptionsHtml}
            </div>
          </div>
          <div class="la-date-custom-row">
            <span class="la-custom-label">Custom:</span>
            <button type="button" id="la-date-from-trigger" class="la-date-field">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="4" width="18" height="18" rx="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
              </svg>
              <span id="la-date-from-text">From</span>
            </button>
            <span class="la-date-sep">to</span>
            <button type="button" id="la-date-to-trigger" class="la-date-field">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="4" width="18" height="18" rx="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
              </svg>
              <span id="la-date-to-text">To</span>
            </button>
            <input id="la-date-from" type="hidden" />
            <input id="la-date-to" type="hidden" />
          </div>
        </div>
      </div>

      <div class="la-sort-row">
        <button class="la-sort-btn" data-sort="likes">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M7 10v12"></path>
            <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"></path>
          </svg>
          <span>Likes</span>
        </button>
        <button class="la-sort-btn" data-sort="comments">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"></path>
          </svg>
          <span>Comments</span>
        </button>
        <button class="la-sort-btn" data-sort="shares">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="18" cy="5" r="3"></circle>
            <circle cx="6" cy="12" r="3"></circle>
            <circle cx="18" cy="19" r="3"></circle>
            <line x1="8.59" x2="15.42" y1="13.51" y2="17.49"></line>
            <line x1="15.41" x2="8.59" y1="6.51" y2="10.49"></line>
          </svg>
          <span>Shares</span>
        </button>
        <button class="la-sort-btn" data-sort="engagement">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M3 3v16a2 2 0 0 0 2 2h16"></path>
            <path d="M18 17V9"></path>
            <path d="M13 17V5"></path>
            <path d="M8 17v-3"></path>
          </svg>
          <span>Engagement
            <span class="la-engagement-tip">
              <svg class="la-help-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
                <circle cx="12" cy="17.5" r="1"></circle>
              </svg>
              <span class="la-tip">Engagement = Likes + Comments + Shares</span>
            </span>
          </span>
        </button>
      </div>

      <div class="la-status" id="la-status">
        <div class="la-spinner"></div>
        <span id="la-status-text">Collecting posts...</span>
      </div>

      <div class="la-footer">
        <div class="la-export-row" id="la-export-row">
          <div class="la-export-wrapper">
            <button class="la-export-trigger" id="la-export-trigger">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              Export Data
            </button>
            <div class="la-export-dropdown" id="la-export-dropdown">
              <button class="la-export-option la-export-option--excel" data-export="excel">
                <div class="la-export-option-icon la-export-option-icon--excel">XLS</div>
                <div class="la-export-option-text">
                  <strong>Excel</strong>
                  <span>Spreadsheet (.xlsx)</span>
                </div>
              </button>
              <button class="la-export-option la-export-option--csv" data-export="csv">
                <div class="la-export-option-icon la-export-option-icon--csv">CSV</div>
                <div class="la-export-option-text">
                  <strong>CSV</strong>
                  <span>Comma-separated (.csv)</span>
                </div>
              </button>
              <button class="la-export-option la-export-option--json" data-export="json">
                <div class="la-export-option-icon la-export-option-icon--json">{ }</div>
                <div class="la-export-option-text">
                  <strong>JSON</strong>
                  <span>Raw data (.json)</span>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  feedToggleWrapper.parentNode?.insertBefore(sortControls, feedToggleWrapper.nextSibling);

  setupSortControlsListeners();

}

let qp_selectedCount: number | 'all' = 25;
let qp_userPlan: 'free' | 'premium' = 'free';
let qp_isActive = false;
let qp_sortType: string | null = null;
let qp_sortMode: 'posts' | 'date' = 'posts';
let qp_datePreset: QPDatePreset = 'week';
let qp_dateFrom: string = '';
let qp_dateTo: string = '';
let qp_dateControls: QuickPanelDateControlsApi | null = null;
let qp_targetCount = 25;
let qp_isCollectAll = false;
let qp_posts: Map<string, LinkedInEntity> = new Map();
let qp_sortedPosts: PostData[] = [];

const QP_DATE_PRESET_LABELS: Record<QPDatePreset, string> = {
  week: 'Posts from 1 Week Back',
  month1: 'Posts from 1 Month Back',
  month3: 'Posts from 3 Months Back',
  month6: 'Posts from 6 Months Back',
  year1: 'Posts from 1 Year Back',
  all: 'All Posts',
};

function qp_validPostCount(): number {
  let count = 0;
  for (const p of qp_posts.values()) {
    if (p.authorName !== 'Unknown' || p.numLikes > 0 || p.numComments > 0) count++;
  }
  return count;
}
let qp_isScrolling = false;
let qp_scrollTimeout: ReturnType<typeof setTimeout> | null = null;
let qp_checkInterval: ReturnType<typeof setInterval> | null = null;
let qp_lastScrollHeight = 0;
let qp_noChangeCount = 0;
let qp_noNewPostsCount = 0;
let qp_lastPostCount = 0;

const QP_SCROLL_DELAY = 3000;
const QP_CHECK_INTERVAL = 1500;
const QP_MAX_NO_CHANGE = 4;
const QP_MAX_NO_NEW_POSTS = 8;

function setupSortControlsListeners(): void {
  const sortButtons = document.querySelectorAll('.la-sort-btn');
  const countButtons = document.querySelectorAll('.la-count-btn');
  const restoreBtn = document.getElementById('la-restore-btn');
  const customInput = document.getElementById('la-custom-count') as HTMLInputElement | null;
  const modeButtons = document.querySelectorAll('.la-mode-btn');
  const sectionTitle = document.querySelector('.la-section-title') as HTMLElement | null;
  const postsConfig = document.getElementById('la-posts-config');
  const dateConfig = document.getElementById('la-date-config');

  const applyModeUI = () => {
    if (sectionTitle) sectionTitle.textContent = qp_sortMode === 'date' ? 'Sort by Date' : 'Sort by Posts';
    if (postsConfig) postsConfig.classList.toggle('hidden', qp_sortMode !== 'posts');
    if (dateConfig) dateConfig.classList.toggle('hidden', qp_sortMode !== 'date');
  };

  applyModeUI();

  countButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (qp_isActive) return;

      if (btn.classList.contains('locked')) {
        qp_showPremiumModal();
        return;
      }

      const rawCount = btn.getAttribute('data-count') || '25';
      const count: number | 'all' = rawCount === 'all' ? 'all' : parseInt(rawCount, 10);

      countButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      qp_selectedCount = count;
      if (customInput) {
        customInput.value = typeof count === 'number' ? String(count) : '';
      }
    });
  });

  if (customInput) {
    customInput.addEventListener('input', () => {
      if (qp_isActive) return;
      const parsed = Number(customInput.value);
      if (!Number.isFinite(parsed) || parsed < 1) return;
      if (qp_userPlan === 'free' && parsed > 25) {
        qp_showPremiumModal();
        customInput.value = '25';
        qp_selectedCount = 25;
      } else {
        qp_selectedCount = Math.min(Math.floor(parsed), 2000);
        customInput.value = String(qp_selectedCount);
      }

      countButtons.forEach((b) => {
        b.classList.remove('active');
        const btnCount = b.getAttribute('data-count') || '';
        if (btnCount !== 'all' && parseInt(btnCount, 10) === qp_selectedCount) {
          b.classList.add('active');
        }
      });
    });

    customInput.addEventListener('blur', () => {
      if (qp_isActive) return;
      const parsed = Number(customInput.value);
      const safe = Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.floor(parsed), 2000) : 25;
      const limited = qp_userPlan === 'free' ? Math.min(safe, 25) : safe;
      customInput.value = String(limited);
      qp_selectedCount = limited;

      countButtons.forEach((b) => {
        b.classList.remove('active');
        const btnCount = b.getAttribute('data-count') || '';
        if (btnCount !== 'all' && parseInt(btnCount, 10) === limited) {
          b.classList.add('active');
        }
      });
    });
  }

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.getAttribute('data-mode');
      if (mode !== 'posts' && mode !== 'date') {
        return;
      }
      modeButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      qp_sortMode = mode;
      applyModeUI();
    });
  });

  if (qp_dateControls) {
    qp_dateControls.destroy();
    qp_dateControls = null;
  }
  qp_dateControls = initQuickPanelDateControls({
    root: document,
    isFree: qp_userPlan === 'free',
    initialState: {
      preset: qp_datePreset,
      from: qp_dateFrom,
      to: qp_dateTo,
    },
    onPremiumBlocked: () => qp_showPremiumModal(),
    onChange: (state) => {
      qp_datePreset = state.preset;
      qp_dateFrom = state.from;
      qp_dateTo = state.to;
    },
  });

  sortButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const sortType = btn.getAttribute('data-sort');
      if (!sortType || qp_isActive) return;

      chrome.storage.local.set(
        {
          qp_pending: {
            sortType,
            sortMode: qp_sortMode,
            count: qp_sortMode === 'date' ? 'all' : qp_selectedCount,
            datePreset: qp_datePreset,
            dateFrom: qp_dateFrom,
            dateTo: qp_dateTo,
            ts: Date.now(),
          },
        },
        () => {
          window.location.reload();
        }
      );
    });
  });

  if (restoreBtn) {
    restoreBtn.addEventListener('click', () => location.reload());
  }

  const exportTrigger = document.getElementById('la-export-trigger');
  const exportDropdown = document.getElementById('la-export-dropdown');

  if (exportTrigger && exportDropdown) {
    exportTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      exportDropdown.classList.toggle('open');
    });

    document.addEventListener('click', () => {
      exportDropdown.classList.remove('open');
    });

    exportDropdown.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    document.querySelectorAll('.la-export-option').forEach((btn) => {
      btn.addEventListener('click', () => {
        const format = btn.getAttribute('data-export');
        if (format === 'excel') qp_exportExcel();
        else if (format === 'csv') qp_exportCSV();
        else if (format === 'json') qp_exportJSON();
        exportDropdown.classList.remove('open');
      });
    });
  }
}

function qp_showPremiumModal(): void {
  const existing = document.getElementById('la-premium-modal-backdrop');
  if (existing) existing.remove();

  const backdrop = document.createElement('div');
  backdrop.id = 'la-premium-modal-backdrop';
  backdrop.innerHTML = `
    <div id="la-premium-modal">
      <button class="la-pm-close" id="la-pm-close">&times;</button>
      <div class="la-pm-title">Upgrade to Premium</div>
      <div class="la-pm-subtitle">Unlock the full power of LinkedIn Analyzer</div>
      <div class="la-pm-features">
        <div class="la-pm-feature">
          <div class="la-pm-feature-icon-wrap">
            <svg class="la-pm-feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M7.5 14.25v2.25m3-4.5v4.5m3-6.75v6.75m3-9v9M6 20.25h12A2.25 2.25 0 0020.25 18V6A2.25 2.25 0 0018 3.75H6A2.25 2.25 0 003.75 6v12A2.25 2.25 0 006 20.25z"/>
            </svg>
          </div>
          <div class="la-pm-feature-text">
            <strong>Sort up to 2000 posts</strong>
            <span>Free plan is limited to 25 posts</span>
          </div>
        </div>
        <div class="la-pm-feature">
          <div class="la-pm-feature-icon-wrap">
            <svg class="la-pm-feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15.75 15.75l-2.489-2.489m0 0a3.375 3.375 0 10-4.773-4.773 3.375 3.375 0 004.774 4.774zM21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
            </svg>
          </div>
          <div class="la-pm-feature-text">
            <strong>Deep feed analysis</strong>
            <span>Analyze large feeds with precision</span>
          </div>
        </div>
        <div class="la-pm-feature">
          <div class="la-pm-feature-icon-wrap">
            <svg class="la-pm-feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"/>
            </svg>
          </div>
          <div class="la-pm-feature-text">
            <strong>Quick Panel — unlimited</strong>
            <span>Sort 50, 100+ posts directly from feed</span>
          </div>
        </div>
        <div class="la-pm-feature">
          <div class="la-pm-feature-icon-wrap">
            <svg class="la-pm-feature-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.631 8.41m5.96 5.96a14.926 14.926 0 01-5.841 2.58m-.119-8.54a6 6 0 00-7.381 5.84h4.8m2.581-5.84a14.927 14.927 0 00-2.58 5.84m2.699 2.7c-.103.021-.207.041-.311.06a15.09 15.09 0 01-2.448-2.448 14.9 14.9 0 01.06-.312m-2.24 2.39a4.493 4.493 0 00-1.757 4.306 4.493 4.493 0 004.306-1.758M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z"/>
            </svg>
          </div>
          <div class="la-pm-feature-text">
            <strong>Priority support</strong>
            <span>Get help faster when you need it</span>
          </div>
        </div>
      </div>
      <button class="la-pm-cta" id="la-pm-cta">Get Premium</button>
      <div class="la-pm-price">Starting at $4.99/month</div>
    </div>
  `;
  document.body.appendChild(backdrop);

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) backdrop.remove();
  });

  document.getElementById('la-pm-close')?.addEventListener('click', () => backdrop.remove());
  document.getElementById('la-pm-cta')?.addEventListener('click', () => {
    backdrop.remove();
  });
}

function qp_checkPending(): void {
  chrome.storage.local.get(['qp_pending'], (result) => {
    const p = result.qp_pending;
    if (!p || !p.sortType || Date.now() - p.ts > 30000) {
      chrome.storage.local.remove(['qp_pending']);
      return;
    }

    chrome.storage.local.remove(['qp_pending']);
    qp_start(p.sortType, p.count || 'all', p.sortMode === 'date' ? 'date' : 'posts', {
      datePreset: p.datePreset,
      dateFrom: p.dateFrom,
      dateTo: p.dateTo,
    });
  });
}

function qp_start(
  sortType: string,
  targetCount: number | 'all',
  sortMode: 'posts' | 'date' = 'posts',
  options?: { datePreset?: QPDatePreset; dateFrom?: string; dateTo?: string }
): void {
  if (qp_isActive || qp_isScrolling) return;


  qp_isActive = true;
  qp_sortType = sortType;
  qp_sortMode = sortMode;
  qp_datePreset = options?.datePreset || qp_datePreset;
  qp_dateFrom = options?.dateFrom || '';
  qp_dateTo = options?.dateTo || '';
  if (qp_sortMode === 'date' && qp_userPlan === 'free') {
    qp_datePreset = 'week';
    qp_dateFrom = '';
    qp_dateTo = '';
  }
  const effectiveCount = sortMode === 'date' ? 'all' : targetCount;
  qp_targetCount = effectiveCount === 'all' ? Infinity : effectiveCount;
  qp_isCollectAll = effectiveCount === 'all';
  qp_posts = new Map();
  qp_isScrolling = false;
  qp_lastScrollHeight = 0;
  qp_noChangeCount = 0;
  qp_noNewPostsCount = 0;
  qp_lastPostCount = 0;

  qp_updateUI(sortType, effectiveCount, sortMode, 'collecting');
  qp_showOverlay(0, effectiveCount === 'all' ? 'all' : effectiveCount);
  qp_startAutoScroll();
}

async function qp_startAutoScroll(): Promise<void> {
  if (qp_isScrolling) return;

  qp_isScrolling = true;

  qp_collectFromDOM();
  qp_updateOverlay(qp_validPostCount(), qp_isCollectAll ? 'all' : qp_targetCount);

  qp_checkInterval = setInterval(() => {
    if (!qp_isScrolling) {
      if (qp_checkInterval) clearInterval(qp_checkInterval);
      return;
    }

    qp_collectFromDOM();
    qp_updateOverlay(qp_validPostCount(), qp_isCollectAll ? 'all' : qp_targetCount);
    qp_checkIfComplete();
  }, QP_CHECK_INTERVAL);

  qp_doScroll();
}

function qp_doScroll(): void {
  if (!qp_isScrolling) return;

  qp_collectFromDOM();

  const scrollContainer = getScrollContainer();
  const currentScrollHeight = scrollContainer?.scrollHeight || document.body.scrollHeight;
  const currentScroll = window.scrollY || document.documentElement.scrollTop;

  const isProfile = isProfileActivityPage();
  const scrollStep = isProfile ? 800 : currentScrollHeight;
  const nextScroll = isProfile ? Math.min(currentScroll + scrollStep, currentScrollHeight) : currentScrollHeight;


  try {
    if (scrollContainer) scrollContainer.scrollTop = nextScroll;
    window.scrollTo({ top: nextScroll, behavior: 'auto' });
    document.documentElement.scrollTop = nextScroll;
    document.body.scrollTop = nextScroll;
  } catch (e) {
  }

  setTimeout(() => {
    qp_collectFromDOM();
    qp_updateOverlay(qp_validPostCount(), qp_isCollectAll ? 'all' : qp_targetCount);
  }, 600);

  setTimeout(() => {
    qp_collectFromDOM();
    qp_updateOverlay(qp_validPostCount(), qp_isCollectAll ? 'all' : qp_targetCount);
  }, 1200);

  if (currentScrollHeight === qp_lastScrollHeight) {
    qp_noChangeCount++;
    if (qp_noChangeCount >= QP_MAX_NO_CHANGE) qp_tryClickLoadMore();
  } else {
    qp_noChangeCount = 0;
    qp_lastScrollHeight = currentScrollHeight;
  }

  const scrollDelay = isProfile ? 1500 : QP_SCROLL_DELAY;
  qp_scrollTimeout = setTimeout(() => qp_doScroll(), scrollDelay);
}

function qp_checkIfComplete(): void {
  const currentCount = qp_validPostCount();

  if (qp_sortMode === 'date' && qp_reachedDateBoundary()) {
    qp_stopAutoScroll();
    qp_applySort();
    return;
  }

  if (!qp_isCollectAll && currentCount >= qp_targetCount) {
    qp_stopAutoScroll();
    qp_applySort();
    return;
  }

  if (currentCount === qp_lastPostCount) {
    qp_noNewPostsCount++;
    if (qp_noNewPostsCount >= 2 && qp_noNewPostsCount < QP_MAX_NO_NEW_POSTS) {
      qp_tryClickLoadMore();
    }
    if (qp_noNewPostsCount >= QP_MAX_NO_NEW_POSTS) {
      qp_stopAutoScroll();
      qp_applySort();
    }
  } else {
    qp_noNewPostsCount = 0;
  }

  qp_lastPostCount = currentCount;
}

function qp_reachedDateBoundary(): boolean {
  const range = qp_getDateRangeFilter();
  if (!range.from) return false;

  let hasInRangePosts = false;
  let hasOlderPosts = false;

  for (const post of qp_posts.values()) {
    const ts = getPostDateValue(post, false);
    if (!ts) continue;
    if (ts >= range.from) {
      hasInRangePosts = true;
    } else {
      hasOlderPosts = true;
    }
    if (hasInRangePosts && hasOlderPosts) return true;
  }

  return false;
}

function qp_tryClickLoadMore(): void {
  const buttons = document.querySelectorAll('button');

  for (const btn of buttons) {
    const text = btn.textContent?.toLowerCase() || '';
    const isVisible = (btn as HTMLElement).offsetParent !== null;
    if (!isVisible) continue;

    if (btn.classList.contains('scaffold-finite-scroll__load-button')) {
      btn.click();
      qp_noChangeCount = 0;
      return;
    }

    if (text.includes('показать') && (text.includes('результат') || text.includes('больше'))) {
      btn.click();
      qp_noChangeCount = 0;
      return;
    }
    if ((text.includes('show') || text.includes('see')) && (text.includes('new') || text.includes('more'))) {
      btn.click();
      qp_noChangeCount = 0;
      return;
    }
    if (text.includes('weitere') || text.includes('mehr')) {
      btn.click();
      qp_noChangeCount = 0;
      return;
    }
  }
}

function qp_collectFromDOM(): void {
  const postElements = document.querySelectorAll('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]');

  postElements.forEach((postEl) => {
    const urn =
      postEl.getAttribute('data-urn') ||
      postEl.getAttribute('data-id') ||
      postEl.closest('[data-id]')?.getAttribute('data-id');

    if (!urn) return;

    const post = parsePostElement(postEl);
    if (post && post.activityUrn) {
      const existing = qp_posts.get(post.activityUrn);
        if (
          !existing ||
          existing.authorName === 'Unknown' ||
          (existing.numLikes === 0 && existing.numComments === 0 && post.numLikes > 0) ||
          (existing.text === '' && post.text !== '') ||
          (!existing.timestamp && !!post.timestamp)
        ) {
          qp_posts.set(post.activityUrn, post);
        }
    }
  });

  if (isProfileActivityPage()) {
    const liElements = document.querySelectorAll('.scaffold-finite-scroll__content li');
    liElements.forEach((li) => {
      const inner = li.querySelector('[data-urn^="urn:li:activity:"], [data-id^="urn:li:activity:"]');
      if (inner) return; // already handled above

      const urnEl = li.querySelector('[data-id]');
      const urn = urnEl?.getAttribute('data-id') || '';
      if (!urn || !urn.includes('activity:')) return;

      const post = parsePostElement(urnEl!);
      if (post && post.activityUrn && !qp_posts.has(post.activityUrn)) {
        qp_posts.set(post.activityUrn, post);
      }
    });
  }
}

function qp_stopAutoScroll(): void {
  qp_isScrolling = false;
  if (qp_scrollTimeout) {
    clearTimeout(qp_scrollTimeout);
    qp_scrollTimeout = null;
  }
  if (qp_checkInterval) {
    clearInterval(qp_checkInterval);
    qp_checkInterval = null;
  }
}

function qp_stop(): void {
  qp_stopAutoScroll();
  qp_hideOverlay();
  qp_isActive = false;
  qp_isScrolling = false;
  qp_sortType = null;
  qp_isCollectAll = false;
  qp_posts = new Map();

  document.querySelectorAll('.la-sort-btn').forEach((b) => b.classList.remove('active', 'loading'));
  document.getElementById('la-status')?.classList.remove('visible');
}

async function qp_applySort(): Promise<void> {
  if (!qp_sortType) return;

  qp_updateOverlayText('Preparing...');

  qp_collectFromDOM();

  const posts = Array.from(qp_posts.values());
  const validPosts = posts.filter((p) => p.authorName !== 'Unknown' || p.numLikes > 0 || p.numComments > 0);

  if (validPosts.length === 0) {
    qp_updateOverlayText('No posts found');
    setTimeout(() => qp_finish(), 2000);
    return;
  }

  let postsForSorting = validPosts;
  if (qp_sortMode === 'date') {
    const range = qp_getDateRangeFilter();
    postsForSorting = validPosts.filter((p) => {
      const ts = getPostDateValue(p, false);
      if (!ts) return false;
      if (range.from && ts < range.from) return false;
      if (range.to && ts > range.to) return false;
      return true;
    });
    if (postsForSorting.length === 0) {
      qp_updateOverlayText('No posts in selected date range');
      setTimeout(() => qp_finish(), 1800);
      return;
    }
  }

  qp_updateOverlayText('Sorting posts...');
  const allSorted = sortPosts(postsForSorting, qp_sortType);
  const sorted = qp_isCollectAll ? allSorted : allSorted.slice(0, qp_targetCount);
  qp_updateOverlayText(`Applying ${sorted.length} posts...`);

  const urns = sorted.map((p) => p.activityUrn);
  const data: PostData[] = sorted.map((p) => ({
    activityUrn: p.activityUrn,
    authorName: p.authorName || 'Unknown',
    text: p.text || '',
    numLikes: p.numLikes || 0,
    numComments: p.numComments || 0,
    numShares: p.numShares || 0,
  }));

  qp_sortedPosts = data;

  qp_hideOverlay();

  await reorderFeedPosts(urns, data, true, qp_isCollectAll ? 0 : qp_targetCount);

  window.scrollTo({ top: 0, behavior: 'smooth' });
  await new Promise((r) => setTimeout(r, 800));

  qp_finish();
}

function qp_finish(): void {
  qp_hideOverlay();
  qp_isActive = false;
  qp_sortType = null;

  const restoreBtn = document.getElementById('la-restore-btn');
  if (restoreBtn) restoreBtn.style.display = 'flex';

  const exportRow = document.getElementById('la-export-row');
  if (exportRow && qp_sortedPosts.length > 0 && qp_userPlan === 'premium') exportRow.style.display = 'flex';

  document.querySelectorAll('.la-sort-btn').forEach((b) => b.classList.remove('loading'));
  document.getElementById('la-status')?.classList.remove('visible');
}

function qp_getExportData() {
  return qp_sortedPosts.map((p, i) => ({
    '#': i + 1,
    Author: p.authorName || '',
    'Post Text': (p.text || '').substring(0, 500),
    Likes: p.numLikes || 0,
    Comments: p.numComments || 0,
    Shares: p.numShares || 0,
    'Post URL': p.activityUrn ? `https://www.linkedin.com/feed/update/${p.activityUrn}` : '',
  }));
}

function qp_triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function qp_exportExcel(): void {
  const data = qp_getExportData();
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 4 }, { wch: 25 }, { wch: 60 }, { wch: 8 }, { wch: 10 }, { wch: 8 }, { wch: 50 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'LinkedIn Posts');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  qp_triggerDownload(
    new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    'linkedin-posts.xlsx'
  );
}

function qp_exportCSV(): void {
  const data = qp_getExportData();
  const headers = Object.keys(data[0] || {});
  const csvRows = [
    headers.join(','),
    ...data.map((row) =>
      headers
        .map((h) => {
          const val = String((row as Record<string, unknown>)[h] ?? '');
          return `"${val.replace(/"/g, '""')}"`;
        })
        .join(',')
    ),
  ];
  qp_triggerDownload(
    new Blob(['\uFEFF' + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' }),
    'linkedin-posts.csv'
  );
}

function qp_exportJSON(): void {
  const data = qp_getExportData();
  qp_triggerDownload(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'linkedin-posts.json');
}

function qp_getDateRangeFilter(): { from?: number; to?: number } {
  const now = Date.now();
  if (qp_dateFrom || qp_dateTo) {
    const from = qp_dateFrom ? new Date(`${qp_dateFrom}T00:00:00`).getTime() : undefined;
    const to = qp_dateTo ? new Date(`${qp_dateTo}T23:59:59`).getTime() : undefined;
    return { from, to };
  }

  const dayMs = 24 * 60 * 60 * 1000;
  switch (qp_datePreset) {
    case 'week':
      return { from: now - 7 * dayMs, to: now };
    case 'month1':
      return { from: now - 30 * dayMs, to: now };
    case 'month3':
      return { from: now - 90 * dayMs, to: now };
    case 'month6':
      return { from: now - 180 * dayMs, to: now };
    case 'year1':
      return { from: now - 365 * dayMs, to: now };
    case 'all':
    default:
      return {};
  }
}

function qp_updateUI(sortType: string, count: number | 'all', sortMode: 'posts' | 'date', _state: string): void {
  document.querySelectorAll('.la-sort-btn').forEach((btn) => {
    btn.classList.remove('active', 'loading');
    if (btn.getAttribute('data-sort') === sortType) btn.classList.add('active', 'loading');
  });

  document.querySelectorAll('.la-count-btn').forEach((btn) => {
    btn.classList.remove('active');
    const btnCount = btn.getAttribute('data-count') || '0';
    if (count === 'all' ? btnCount === 'all' : parseInt(btnCount) === count) btn.classList.add('active');
  });

  const customInput = document.getElementById('la-custom-count') as HTMLInputElement | null;
  if (customInput && typeof count === 'number') {
    customInput.value = String(count);
  }

  document.querySelectorAll('.la-mode-btn').forEach((btn) => {
    btn.classList.remove('active');
    if (btn.getAttribute('data-mode') === sortMode) {
      btn.classList.add('active');
    }
  });

  const sectionTitle = document.querySelector('.la-section-title') as HTMLElement | null;
  const postsConfig = document.getElementById('la-posts-config');
  const dateConfig = document.getElementById('la-date-config');
  if (sectionTitle) sectionTitle.textContent = sortMode === 'date' ? 'Sort by Date' : 'Sort by Posts';
  if (postsConfig) postsConfig.classList.toggle('hidden', sortMode !== 'posts');
  if (dateConfig) dateConfig.classList.toggle('hidden', sortMode !== 'date');

  qp_dateControls?.setState({
    preset: qp_datePreset,
    from: qp_dateFrom,
    to: qp_dateTo,
  });

  document.getElementById('la-status')?.classList.add('visible');
  const statusText = document.getElementById('la-status-text');
  if (statusText) {
    const rangeLabel = qp_dateFrom || qp_dateTo ? 'Custom range' : QP_DATE_PRESET_LABELS[qp_datePreset];
    const baseText =
      sortMode === 'date'
        ? `Collecting posts (${rangeLabel})...`
        : count === 'all'
          ? 'Collecting all posts...'
          : `Collecting ${count} posts...`;
    statusText.textContent = sortMode === 'date' ? `${baseText} (Sort by Date)` : baseText;
  }
}

function qp_showOverlay(current: number, target: number | 'all'): void {
  qp_hideOverlay();

  const backdrop = document.createElement('div');
  backdrop.id = 'qp-backdrop';
  backdrop.innerHTML = `
    <style>
      #qp-backdrop {
        position: fixed;
        top: 0;
        left: 0;
        width: 100vw;
        height: 100vh;
        background: rgba(0, 0, 0, 0.7);
        z-index: 999998;
      }
    </style>
  `;
  document.body.appendChild(backdrop);

  const countDisplay = target === 'all' ? `${current} Posts` : `${current} / ${target}`;
  const subText = target === 'all' ? 'Collecting all posts...' : 'Collecting posts...';

  const overlay = document.createElement('div');
  overlay.id = 'qp-overlay';
  overlay.innerHTML = `
    <style>
      #qp-overlay {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        background: white;
        padding: 40px 60px;
        border-radius: 16px;
        box-shadow: 0 20px 60px rgba(0,0,0,0.5);
        z-index: 999999;
        text-align: center;
        font-family: -apple-system, system-ui, sans-serif;
        min-width: 280px;
      }
      #qp-overlay .spinner {
        width: 60px;
        height: 60px;
        border: 5px solid #e5e7eb;
        border-top-color: #0077B5;
        border-radius: 50%;
        animation: qp-spin 0.8s linear infinite;
        margin: 0 auto 24px;
      }
      @keyframes qp-spin {
        to { transform: rotate(360deg); }
      }
      #qp-overlay .count {
        font-size: 36px;
        font-weight: 700;
        color: #0077B5;
        margin-bottom: 8px;
      }
      #qp-overlay .text {
        font-size: 14px;
        color: #6b7280;
        margin-bottom: 8px;
      }
      #qp-overlay .hint {
        font-size: 13px;
        color: #9ca3af;
      }
      #qp-stop-sort-btn {
        margin-top: 16px;
        padding: 10px 28px;
        background: linear-gradient(135deg, #dc2626 0%, #b91c1c 100%);
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        transition: transform 0.15s, box-shadow 0.15s;
        box-shadow: 0 2px 8px rgba(220, 38, 38, 0.3);
      }
      #qp-stop-sort-btn:hover {
        transform: scale(1.03);
        box-shadow: 0 4px 12px rgba(220, 38, 38, 0.4);
      }
    </style>
    <div class="spinner"></div>
    <div class="count" id="qp-count">${countDisplay}</div>
    <div class="text" id="qp-text">${subText}</div>
    <div class="hint">don't scroll manually</div>
    ${target === 'all' ? '<button id="qp-stop-sort-btn">Stop & Sort Now</button>' : ''}
  `;
  document.body.appendChild(overlay);

  if (target === 'all') {
    const stopBtn = document.getElementById('qp-stop-sort-btn');
    if (stopBtn) {
      stopBtn.addEventListener('click', () => {
        stopBtn.textContent = 'Stopping...';
        stopBtn.style.opacity = '0.6';
        stopBtn.style.pointerEvents = 'none';
        qp_stopAutoScroll();
        qp_applySort();
      });
    }
  }
}

function qp_updateOverlay(current: number, target: number | 'all'): void {
  const countEl = document.getElementById('qp-count');
  if (countEl) {
    if (target === 'all') {
      countEl.textContent = `${current} Posts`;
    } else {
      const display = Math.min(current, target);
      countEl.textContent = `${display} / ${target}`;
    }
  }
}

function qp_updateOverlayText(text: string): void {
  const textEl = document.getElementById('qp-text');
  if (textEl) textEl.textContent = text;
}

function qp_hideOverlay(): void {
  const overlay = document.getElementById('qp-overlay');
  const backdrop = document.getElementById('qp-backdrop');
  if (overlay) overlay.remove();
  if (backdrop) backdrop.remove();
}

function _getCollectionState(): Promise<{
  currentCount: number;
  isCollecting: boolean;
  targetCount?: number | 'all';
  collectionMode?: CollectionMode;
}> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_COLLECTION_STATE' }, (response) => {
      resolve(response || { currentCount: 0, isCollecting: false });
    });
  });
}

function _getCollectedPosts(): Promise<LinkedInEntity[]> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'GET_POSTS' }, (response) => {
      resolve(response?.posts || []);
    });
  });
}

function sortPosts(posts: LinkedInEntity[], sortType: string): LinkedInEntity[] {
  return [...posts].sort((a, b) => {
    const metricDiff = getSortMetricValue(b, sortType) - getSortMetricValue(a, sortType);
    if (metricDiff !== 0) return metricDiff;

    const dateDiff = getPostDateValue(b, false) - getPostDateValue(a, false);
    if (dateDiff !== 0) return dateDiff;

    return (b.activityUrn || '').localeCompare(a.activityUrn || '');
  });
}

function getSortMetricValue(post: LinkedInEntity, sortType: string): number {
  switch (sortType) {
    case 'likes':
      return post.numLikes || 0;
    case 'comments':
      return post.numComments || 0;
    case 'shares':
      return post.numShares || 0;
    case 'engagement':
      return (post.numLikes || 0) + (post.numComments || 0) * 2 + (post.numShares || 0) * 3;
    default:
      return 0;
  }
}

function getPostDateValue(post: LinkedInEntity, allowUrnFallback: boolean = true): number {
  if (typeof post.timestamp === 'number' && Number.isFinite(post.timestamp)) return post.timestamp;
  if (!allowUrnFallback) return 0;
  const urn = typeof post.activityUrn === 'string' ? post.activityUrn : '';
  const match = urn.match(/activity:(\d+)/);
  if (match) return Number(match[1]);
  return 0;
}

function isProfileActivityPage(): boolean {
  return /\/in\/[^/]+\/recent-activity/.test(window.location.pathname);
}

function isMainFeedPage(): boolean {
  return window.location.pathname === '/feed/' || window.location.pathname === '/feed';
}

function initInlineControls(): void {
  if (isMainFeedPage()) {
    const checkFeed = setInterval(() => {
      let feedToggle: Element | null = document.querySelector('.feed-sort-toggle-dsa__wrapper');
      if (!feedToggle) {
        const hr = document.querySelector('hr.feed-index-sort-border');
        if (hr) feedToggle = hr.closest('.artdeco-dropdown') || hr.closest('.mb2');
      }
      if (!feedToggle) {
        const buttons = document.querySelectorAll('button.artdeco-dropdown__trigger');
        for (const btn of buttons) {
          const text = btn.textContent || '';
          if (text.includes('Сортировать') || text.includes('Sort by') || text.includes('Sortieren')) {
            feedToggle = btn.closest('.artdeco-dropdown');
            break;
          }
        }
      }
      if (!feedToggle) {
        feedToggle = document.querySelector('.share-box-feed-entry__closed-share-box');
      }
      if (!feedToggle) {
        const sortDropdown = document.querySelector('.mb2.artdeco-dropdown');
        if (sortDropdown && (sortDropdown.textContent?.includes('Sort by') || sortDropdown.textContent?.includes('Сортировать') || sortDropdown.querySelector('hr.feed-index-sort-border'))) {
          feedToggle = sortDropdown;
        }
      }
      if (feedToggle) {
        clearInterval(checkFeed);
        injectSortControls();
        checkPendingQuickSort();
      }
    }, 1000);
    setTimeout(() => clearInterval(checkFeed), 30000);
  } else if (isProfileActivityPage()) {
    const checkProfile = setInterval(() => {
      const anchor = findProfileAnchor();
      if (anchor) {
        clearInterval(checkProfile);
        injectSortControls();
        checkPendingQuickSort();
      }
    }, 1000);
    setTimeout(() => clearInterval(checkProfile), 30000);
  }
}

function findProfileAnchor(): Element | null {
  const headings = document.querySelectorAll('h2.text-heading-large');
  for (const h of headings) {
    const text = h.textContent?.trim() || '';
    if (
      text.includes('Все действия') ||
      text.includes('All activity') ||
      text.includes('Alle Aktivitäten') ||
      text.includes('Toda la actividad')
    ) {
      return h;
    }
  }

  const pillsContainer = document.querySelector('.profile-creator-shared-pills__pill')?.closest('.mb3');
  if (pillsContainer) return pillsContainer;

  const activitySection = document.querySelector('.scaffold-finite-scroll');
  if (activitySection) {
    const prevH2 = activitySection.previousElementSibling;
    if (prevH2?.tagName === 'H2') return prevH2;
  }

  return null;
}

function checkPendingQuickSort(): void {
  qp_checkPending();
}

initInlineControls();

let lastUrl = location.href;
new MutationObserver(() => {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    setTimeout(initInlineControls, 1000);
  }
}).observe(document, { subtree: true, childList: true });
