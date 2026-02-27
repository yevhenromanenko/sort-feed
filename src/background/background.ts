import type { LinkedInAPIResponse, LinkedInEntity, LinkedInPost, PageType, CollectionMode } from 'types/linkedin';
import { parseLinkedInResponse } from 'utils/parser';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'LINKEDIN_FEED_DATA') {
    handleFeedData(message.data as LinkedInAPIResponse, message.feedType);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'DOM_POSTS') {
    handleDOMPosts(message.posts);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'SYNC_DOM_METRICS') {
    syncDOMMetrics(message.updates);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_POSTS') {
    chrome.storage.local.get(['linkedinPosts'], (result) => {
      const data = result.linkedinPosts || { posts: [], lastUpdate: 0 };
      sendResponse(data);
    });
    return true;
  }

  if (message.type === 'CLEAR_POSTS') {
    chrome.storage.local.set({ linkedinPosts: { posts: [], lastUpdate: 0 } }, () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (message.type === 'START_COLLECTION') {
    const pageType: PageType = message.pageType || 'main-feed';
    const rawTargetCount = message.targetCount;
    const isCollectAll = rawTargetCount === 'all';
    const DEFAULT_COUNT = 25;
    const MAX_COUNT = 2000;

    let requestedCount = -1;
    if (!isCollectAll) {
      const parsedCount = Number(rawTargetCount);
      if (Number.isFinite(parsedCount) && parsedCount > 0) {
        requestedCount = Math.min(Math.floor(parsedCount), MAX_COUNT);
      } else {
        requestedCount = DEFAULT_COUNT;
      }
    }

    const BUFFER_SIZE = 11;
    const targetCount = isCollectAll ? -1 : requestedCount + BUFFER_SIZE;
    const collectionMode: CollectionMode = message.collectionMode || 'precision';
    const sortType = message.sortType || 'likes';

    chrome.storage.local.set(
      {
        linkedinPosts: { posts: [], lastUpdate: 0 },
        collectionState: {
          isCollecting: true,
          targetCount: targetCount,
          requestedCount: requestedCount,
          collectAll: isCollectAll,
          pageType: pageType,
          tabId: message.tabId,
          collectionMode: collectionMode,
          sortType: sortType,
        },
      },
      () => {
        sendResponse({ success: true });
      }
    );
    return true;
  }

  if (message.type === 'STOP_COLLECTION') {
    chrome.storage.local.get(['collectionState'], (result) => {
      const state = result.collectionState || {};
      chrome.storage.local.set(
        {
          collectionState: { ...state, isCollecting: false },
        },
        () => {
          sendResponse({ success: true });
        }
      );
    });
    return true;
  }

  if (message.type === 'GET_COLLECTION_STATE') {
    chrome.storage.local.get(['linkedinPosts', 'collectionState'], (result) => {
      const posts = result.linkedinPosts?.posts || [];
      const state = result.collectionState || {
        isCollecting: false,
        targetCount: 0,
        requestedCount: 0,
        collectAll: false,
        pageType: 'main-feed',
        collectionMode: 'precision',
      };
      const isAll = state.collectAll === true;
      const displayCount =
        state.requestedCount > 0 ? state.requestedCount : state.targetCount > 0 ? state.targetCount : 0;

      sendResponse({
        isCollecting: state.isCollecting,
        targetCount: isAll ? 'all' : displayCount,
        currentCount: isAll ? posts.length : Math.min(posts.length, displayCount || 0),
        collectAll: isAll,
        pageType: state.pageType,
        collectionMode: state.collectionMode || 'precision',
        sortType: state.sortType || 'likes',
        requestedCount: state.requestedCount || 0,
      });
    });
    return true;
  }

  return false;
});

async function handleFeedData(response: LinkedInAPIResponse, feedType?: 'main' | 'profile') {
  try {
    const mainFeedElements = response.data?.data?.feedDashMainFeedByMainFeed?.['*elements'] || [];
    const profileFeedData = response.data?.data?.feedDashProfileUpdatesByMemberShareFeed;
    let profileFeedElements: string[] = [];

    if (profileFeedData) {
      profileFeedElements = profileFeedData['*elements'] || [];
      if (profileFeedElements.length === 0 && profileFeedData.elements) {
        profileFeedElements = profileFeedData.elements
          .map((el: LinkedInEntity) => (el['*update'] || el.entityUrn || el.urn) as string)
          .filter(Boolean);
      }
    }

    const elements = mainFeedElements.length > 0 ? mainFeedElements : profileFeedElements;
    const included = response.included || [];

    const parsedPosts = parseLinkedInResponse(response, feedType);

    if (parsedPosts.length === 0) {
      return;
    }

    const postsWithMetrics = parsedPosts.filter((p) => p.numLikes > 0 || p.numComments > 0 || p.numShares > 0);

    const result = await chrome.storage.local.get(['linkedinPosts', 'collectionState']);
    const existingData = result.linkedinPosts || { posts: [], lastUpdate: 0 };
    const collectionState = result.collectionState || { isCollecting: false, targetCount: 0, collectAll: false };

    const existingPostsMap = new Map<string, LinkedInPost>(
      existingData.posts.map((p: LinkedInPost) => [p.activityUrn, p])
    );

    for (const newPost of parsedPosts) {
      const existing = existingPostsMap.get(newPost.activityUrn);

      if (existing) {
        const existingScore = existing.numLikes + existing.numComments + existing.numShares;
        const newScore = newPost.numLikes + newPost.numComments + newPost.numShares;

        if (newScore > existingScore) {
          existingPostsMap.set(newPost.activityUrn, newPost);
        }
      } else {
        existingPostsMap.set(newPost.activityUrn, newPost);
      }
    }

    existingData.posts = Array.from(existingPostsMap.values());
    existingData.lastUpdate = Date.now();

    await chrome.storage.local.set({ linkedinPosts: existingData });

    const targetDisplay = collectionState.collectAll ? 'all' : collectionState.targetCount;

    if (
      collectionState.isCollecting &&
      !collectionState.collectAll &&
      collectionState.targetCount > 0 &&
      existingData.posts.length >= collectionState.targetCount
    ) {
      await chrome.storage.local.set({
        collectionState: { ...collectionState, isCollecting: false },
      });

      if (collectionState.tabId) {
        chrome.tabs
          .sendMessage(collectionState.tabId, {
            type: 'STOP_AUTO_SCROLL',
          })
          .catch(() => {});
      }
    }
  } catch (error) {}
}

async function syncDOMMetrics(
  updates: Array<{
    activityUrn: string;
    numLikes: number;
    numComments: number;
    numShares: number;
    authorName?: string;
  }>
) {
  try {
    if (!updates || updates.length === 0) return;

    const result = await chrome.storage.local.get(['linkedinPosts']);
    const existingData = result.linkedinPosts || { posts: [], lastUpdate: 0 };

    if (existingData.posts.length === 0) return;

    const postsMap = new Map<string, LinkedInPost>(existingData.posts.map((p: LinkedInPost) => [p.activityUrn, p]));

    let updatedCount = 0;

    for (const update of updates) {
      const existing = postsMap.get(update.activityUrn);

      if (existing) {
        const existingScore = existing.numLikes + existing.numComments + existing.numShares;
        const domScore = update.numLikes + update.numComments + update.numShares;

        if (domScore > existingScore) {
          existing.numLikes = Math.max(existing.numLikes, update.numLikes);
          existing.numComments = Math.max(existing.numComments, update.numComments);
          existing.numShares = Math.max(existing.numShares, update.numShares);

          if (existing.authorName === 'Unknown' && update.authorName && update.authorName !== 'Unknown') {
            existing.authorName = update.authorName;
          }

          postsMap.set(update.activityUrn, existing);
          updatedCount++;
        }
      }
    }

    if (updatedCount > 0) {
      existingData.posts = Array.from(postsMap.values());
      existingData.lastUpdate = Date.now();
      await chrome.storage.local.set({ linkedinPosts: existingData });
    }
  } catch (error) {}
}

async function handleDOMPosts(posts: LinkedInPost[]) {
  try {
    if (!posts || posts.length === 0) {
      return;
    }

    const result = await chrome.storage.local.get(['linkedinPosts', 'collectionState']);
    const existingData = result.linkedinPosts || { posts: [], lastUpdate: 0 };
    const collectionState = result.collectionState || { isCollecting: false };

    if (!collectionState.isCollecting) {
      return;
    }

    const existingPostsMap = new Map<string, LinkedInPost>(
      existingData.posts.map((p: LinkedInPost) => [p.activityUrn, p])
    );

    for (const domPost of posts) {
      const existing = existingPostsMap.get(domPost.activityUrn);

      if (existing) {
        const existingScore = existing.numLikes + existing.numComments + existing.numShares;
        const domScore = domPost.numLikes + domPost.numComments + domPost.numShares;

        if (domScore > existingScore) {
          existingPostsMap.set(domPost.activityUrn, domPost);
        }
      } else {
        existingPostsMap.set(domPost.activityUrn, domPost);
      }
    }

    existingData.posts = Array.from(existingPostsMap.values());
    existingData.lastUpdate = Date.now();

    await chrome.storage.local.set({ linkedinPosts: existingData });
  } catch (error) {}
}
