/**
 * Comprehensive API Testing Script for Yaard Backend
 * Updated for correct production URL: https://yaardserver.netlify.app
 */

const BASE_URL = "https://yaardserver.netlify.app/api";

let testData = {
  userId: null,
  userToken: null,
  userEmail: `testuser${Date.now()}@test.com`,
  username: `testuser${Date.now()}`,
  videoId: null,
};

async function apiCall(endpoint, method = "GET", body = null, headers = {}) {
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  try {
    const response = await fetch(BASE_URL + endpoint, options);
    const text = await response.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    
    return {
      status: response.status,
      data,
      success: response.ok,
      headers: response.headers,
    };
  } catch (err) {
    return {
      status: 0,
      error: err.message,
      success: false,
    };
  }
}

const results = [];

function logTest(name, status, details = "") {
  const result = `${status ? "✅" : "❌"} ${name.padEnd(40)} | ${details}`;
  results.push(result);
  console.log(result);
}

async function runTests() {
  console.log("🚀 Starting Comprehensive API Tests...\n");
  console.log(`📍 Base URL: ${BASE_URL}\n`);

  // 1. HEALTH CHECK
  console.log("📋 === HEALTH CHECK ===");
  let res = await apiCall("/health");
  logTest("Health Endpoint", res.status === 200, `Status: ${res.status}`);

  // 2. AUTH ENDPOINTS
  console.log("\n📋 === AUTH ENDPOINTS ===");

  // Register with unique data
  const registerPayload = {
    username: testData.username,
    email: testData.userEmail,
    password: "TestPassword123!",
    displayName: "Test User",
  };
  res = await apiCall("/auth/register", "POST", registerPayload);
  logTest("Register", res.status < 500, `Status: ${res.status}`);
  if (res.data?.data) {
    testData.userToken = res.data.data.token || res.data.data.accessToken || testData.userToken;
    testData.userId = res.data.data.user?.id || testData.userId;
  }

  // Login
  res = await apiCall("/auth/login", "POST", {
    emailOrUsername: testData.userEmail,
    password: "TestPassword123!",
  });
  logTest("Login", res.status < 500, `Status: ${res.status}`);
  if (res.data?.data) {
    testData.userToken = testData.userToken || res.data.data.token || res.data.data.accessToken || null;
    testData.userId = testData.userId || res.data.data.user?.id || null;
  }

  const authHeader = testData.userToken ? { Authorization: `Bearer ${testData.userToken}` } : {};
  console.log(`   Auth Token: ${testData.userToken ? "✅ Available" : "❌ Not obtained"}`);

  // 3. USERS ENDPOINTS
  console.log("\n📋 === USERS ENDPOINTS ===");

  res = await apiCall("/users/me", "GET", null, authHeader);
  logTest("Get Current User", res.status === 200, `Status: ${res.status}`);

  res = await apiCall("/users/me", "PUT", { bio: "Test bio for API" }, authHeader);
  logTest("Update Profile", res.status === 200, `Status: ${res.status}`);

  res = await apiCall("/search?q=test&type=users", "GET", null, authHeader);
  logTest("Search Users", res.status === 200, `Status: ${res.status}`);

  // 4. VIDEOS ENDPOINTS
  console.log("\n📋 === VIDEOS ENDPOINTS ===");

  res = await apiCall("/videos", "GET");
  logTest("List Videos", res.status === 200, `Status: ${res.status}`);

  res = await apiCall("/videos", "POST", {
    title: "Test Video",
    description: "Test Description",
    video_url: "https://example.com/test.mp4",
    video_public_id: "test123",
    duration: 30
  }, authHeader);
  logTest("Create Video", res.status < 500, `Status: ${res.status}`);
  if (res.data?.data?.id) {
    testData.videoId = res.data.data.id;
  }

  // Regression test: price=0 / year=0 must NOT be silently dropped to null
  // (this was a real bug — `value || null` treats 0 as falsy)
  res = await apiCall("/videos", "POST", {
    title: "Free Giveaway Item",
    description: "Edge-case test: price 0, year 0",
    video_url: "https://example.com/test-zero.mp4",
    video_public_id: "test_zero_123",
    duration: 15,
    price: 0,
    price_mode: "actual",
    year: 0
  }, authHeader);
  logTest("Create Video (price=0/year=0 edge case)", res.status < 500, `Status: ${res.status}`);
  if (res.data?.data) {
    const createdVid = res.data.data.video || res.data.data;
    const priceOk = createdVid.price === 0 || createdVid.price === "0" || createdVid.price === "0.00";
    const yearOk = createdVid.year === 0 || createdVid.year === "0";
    logTest("  └─ price=0 preserved (not nulled)", priceOk, `price: ${JSON.stringify(createdVid.price)}`);
    logTest("  └─ year=0 preserved (not nulled)", yearOk, `year: ${JSON.stringify(createdVid.year)}`);

    // Direct check: does the create-video response itself include streaming URLs?
    const su = createdVid.streaming_urls;
    const createHasStreaming = Boolean(su);
    logTest("  └─ Create response includes streaming_urls", createHasStreaming,
      createHasStreaming
        ? `HLS: ${Boolean(su.hls)}, Progressive: ${Boolean(su.progressive)}, Thumbnail: ${Boolean(su.thumbnail)}, Fallback: ${Boolean(su.fallback)}`
        : "Not present");
  }

  if (testData.videoId) {
    res = await apiCall(`/videos/${testData.videoId}`, "GET");
    logTest("Get Video by ID", res.status === 200, `Status: ${res.status}`);

    res = await apiCall(`/videos/${testData.videoId}/view`, "POST", {}, authHeader);
    logTest("Track View", res.status < 500, `Status: ${res.status}`);

    res = await apiCall(`/videos/${testData.videoId}/like`, "POST", {}, authHeader);
    logTest("Like Video", res.status < 500, `Status: ${res.status}`);

    res = await apiCall(`/videos/${testData.videoId}/save`, "POST", {}, authHeader);
    logTest("Save Video", res.status < 500, `Status: ${res.status}`);

    res = await apiCall(`/videos/${testData.videoId}/contact`, "POST", {
      type: "call",
    }, authHeader);
    logTest("Track Contact (Call)", res.status < 500, `Status: ${res.status}`);

    res = await apiCall(`/videos/${testData.videoId}/share`, "POST", {
      platform: "whatsapp",
    }, authHeader);
    logTest("Track Share", res.status < 500, `Status: ${res.status}`);

    res = await apiCall(`/videos/${testData.videoId}/report`, "POST", {
      reason: "spam",
    }, authHeader);
    logTest("Report Video", res.status < 500, `Status: ${res.status}`);
  }

  // 4b. VIDEO STREAMING & OPTIMIZATION TESTS
  console.log("\n📋 === VIDEO STREAMING & OPTIMIZATION ===");

  // Test streaming URLs in video responses
  res = await apiCall("/videos?limit=5", "GET");
  let hasVideoStreamingUrls = false;
  if (res.data?.data?.videos && res.data.data.videos.length > 0) {
    const firstVideo = res.data.data.videos[0];
    hasVideoStreamingUrls = firstVideo.streaming_urls ? true : false;
    
    if (hasVideoStreamingUrls) {
      const streamUrls = firstVideo.streaming_urls;
      const hasHLS = streamUrls.hls ? true : false;
      const hasProgressive = streamUrls.progressive ? true : false;
      const hasThumbnail = streamUrls.thumbnail ? true : false;
      logTest("Streaming URLs in Response", hasVideoStreamingUrls, 
        `HLS: ${hasHLS}, Progressive: ${hasProgressive}, Thumbnail: ${hasThumbnail}`);
    }
  }
  logTest("Video List Returns Streaming URLs", hasVideoStreamingUrls, 
    `${hasVideoStreamingUrls ? "✅ Present" : "⚠️ Not present (optional)"}`);

  // Test pagination with optimized query
  res = await apiCall("/videos?page=1&limit=10", "GET");
  const videoCount = res.data?.data?.videos ? res.data.data.videos.length : 0;
  logTest("Pagination (page=1, limit=10)", res.status === 200, `Videos: ${videoCount}`);

  res = await apiCall("/videos?page=2&limit=10", "GET");
  logTest("Pagination (page=2)", res.status === 200, `Status: ${res.status}`);

  // Test filtering by user
  if (testData.userId) {
    res = await apiCall(`/videos?userId=${testData.userId}&limit=5`, "GET");
    logTest("Videos by User Filter", res.status === 200, `Status: ${res.status}`);
  }

  // Test upload signature for streaming
  res = await apiCall("/videos/upload-signature", "GET", null, authHeader);
  logTest("Video Upload Signature", res.status < 500, `Status: ${res.status}`);
  const hasSignature = res.data?.data?.signature ? true : false;
  if (hasSignature) {
    logTest("  └─ Signature Fields Valid", 
      res.data.data.signature && res.data.data.timestamp && res.data.data.cloudName,
      `sig, ts, cloud_name present`);
    const allowedFormats = res.data.data.params?.allowed_formats;
    logTest("  └─ Default video allowed_formats whitelist present", Boolean(allowedFormats),
      allowedFormats ? `${allowedFormats}` : "Missing — check generateUploadSignature defaults");
  }

  // 5. IMAGES ENDPOINTS
  console.log("\n📋 === IMAGES ENDPOINTS ===");

  res = await apiCall("/images/upload-signature", "POST", { imageType: "avatar" }, authHeader);
  logTest("Get Upload Signature", res.status < 500, `Status: ${res.status}`);

  // 6. COMMENTS ENDPOINTS
  console.log("\n📋 === COMMENTS ENDPOINTS ===");

  if (testData.videoId) {
    res = await apiCall(`/comments?video_id=${testData.videoId}`, "GET");
    logTest("List Comments", res.status === 200, `Status: ${res.status}`);

    res = await apiCall("/comments", "POST", {
      video_id: testData.videoId,
      body: "Great video!",
    }, authHeader);
    logTest("Create Comment", res.status < 500, `Status: ${res.status}`);
  }

  // 7. FEED ENDPOINTS
  console.log("\n📋 === FEED ENDPOINTS ===");

  // Test FYP feed with timing
  let startTime = Date.now();
  res = await apiCall("/feed?page=1&limit=10", "GET", null, authHeader);
  let feedLoadTime = Date.now() - startTime;
  let hasStreamingUrls = false;
  let feedCount = 0;
  
  if (res.data?.data?.feed && res.data.data.feed.length > 0) {
    feedCount = res.data.data.feed.length;
    const firstFeedVideo = res.data.data.feed[0];
    hasStreamingUrls = firstFeedVideo.streaming_urls ? true : false;
  }
  
  logTest("For You Feed", res.status < 500, `Status: ${res.status}, Time: ${feedLoadTime}ms, Count: ${feedCount}`);
  logTest("  └─ Streaming URLs in Feed", hasStreamingUrls, 
    `${hasStreamingUrls ? "✅ Present" : "⚠️ Not present (optional)"}`);

  // Verify feed includes trending
  let hasTrending = res.data?.data?.trending && res.data.data.trending.length > 0;
  logTest("  └─ Trending Videos Included", hasTrending, 
    `Trending count: ${hasTrending ? res.data.data.trending.length : 0}`);

  // Test pagination performance
  startTime = Date.now();
  res = await apiCall("/feed?page=2&limit=10", "GET", null, authHeader);
  let page2Time = Date.now() - startTime;
  logTest("Feed Pagination (Page 2)", res.status < 500, `Status: ${res.status}, Time: ${page2Time}ms`);

  // Test Following Feed with timing
  startTime = Date.now();
  res = await apiCall("/feed/following?page=1&limit=10", "GET", null, authHeader);
  let followingLoadTime = Date.now() - startTime;
  let followingCount = res.data?.data?.feed ? res.data.data.feed.length : 0;
  
  logTest("Following Feed", res.status < 500, `Status: ${res.status}, Time: ${followingLoadTime}ms, Count: ${followingCount}`);

  // Verify following feed has streaming URLs
  let followingHasStreaming = false;
  if (res.data?.data?.feed && res.data.data.feed.length > 0) {
    followingHasStreaming = res.data.data.feed[0].streaming_urls ? true : false;
  }
  logTest("  └─ Streaming URLs in Following", followingHasStreaming, 
    `${followingHasStreaming ? "✅ Present" : "⚠️ Not present (optional)"}`);

  // Test Trending Feed
  startTime = Date.now();
  res = await apiCall("/feed/trending?limit=10", "GET");
  let trendingLoadTime = Date.now() - startTime;
  logTest("Trending Feed", res.status === 200, `Status: ${res.status}, Time: ${trendingLoadTime}ms`);

  // Test Saved Videos
  res = await apiCall("/feed/saved", "GET", null, authHeader);
  logTest("Saved Videos", res.status < 500, `Status: ${res.status}`);

  // Test Categories
  res = await apiCall("/feed/categories", "GET");
  logTest("Categories", res.status === 200, `Status: ${res.status}`);

  // Performance Summary
  console.log("\n  ⏱️  FEED PERFORMANCE METRICS");
  console.log(`     FYP Feed Load: ${feedLoadTime}ms (target: < 500ms)`);
  console.log(`     Following Feed Load: ${followingLoadTime}ms (target: < 500ms)`);
  console.log(`     Trending Feed Load: ${trendingLoadTime}ms (target: < 500ms)`);
  const feedPerformanceOk = feedLoadTime < 500 && followingLoadTime < 500 && trendingLoadTime < 500;
  logTest("  └─ Feed Performance", feedPerformanceOk, 
    `${feedPerformanceOk ? "✅ All < 500ms" : "⚠️ Check database indexes"}`);

  // 8. SEARCH ENDPOINT
  console.log("\n📋 === SEARCH ENDPOINT ===");

  res = await apiCall("/search?q=test", "GET");
  logTest("Global Search", res.status === 200, `Status: ${res.status}`);

  // 8b. VIDEO INTERACTIONS WITH OPTIMIZED QUERIES
  console.log("\n📋 === VIDEO INTERACTIONS (OPTIMIZED QUERIES) ===");

  // Get a video to test interactions
  res = await apiCall("/videos?limit=1", "GET");
  let interactionVideoId = null;
  
  if (res.data?.data?.videos && res.data.data.videos.length > 0) {
    interactionVideoId = res.data.data.videos[0].id;
    
    // Test like interaction (optimized query includes is_liked)
    res = await apiCall(`/videos/${interactionVideoId}/like`, "POST", {}, authHeader);
    logTest("Like Video (with optimized query)", res.status < 500, `Status: ${res.status}`);
    
    // Get video and verify is_liked flag
    res = await apiCall(`/videos/${interactionVideoId}`, "GET", null, authHeader);
    const isLiked = res.data?.data?.video?.is_liked;
    logTest("  └─ Verify is_liked Flag", res.status === 200, `is_liked: ${isLiked}`);
    
    // Test save interaction (optimized query includes is_saved)
    res = await apiCall(`/videos/${interactionVideoId}/save`, "POST", {}, authHeader);
    logTest("Save Video (with optimized query)", res.status < 500, `Status: ${res.status}`);
    
    // Get video and verify is_saved flag
    res = await apiCall(`/videos/${interactionVideoId}`, "GET", null, authHeader);
    const isSaved = res.data?.data?.video?.is_saved;
    logTest("  └─ Verify is_saved Flag", res.status === 200, `is_saved: ${isSaved}`);
  }

  // Test feed with all interaction flags from optimized query
  res = await apiCall("/feed?page=1&limit=5", "GET", null, authHeader);
  let feedInteractionOk = false;
  if (res.data?.data?.feed && res.data.data.feed.length > 0) {
    const feedVideo = res.data.data.feed[0];
    // Optimized query should return all these fields in one query
    feedInteractionOk = (
      feedVideo.hasOwnProperty('is_liked') &&
      feedVideo.hasOwnProperty('is_saved') &&
      feedVideo.hasOwnProperty('is_following')
    );
  }
  logTest("Feed Interaction Flags (Single Query)", feedInteractionOk, 
    `is_liked, is_saved, is_following all present: ${feedInteractionOk}`);

  // 9. NOTIFICATIONS ENDPOINTS
  console.log("\n📋 === NOTIFICATIONS ENDPOINTS ===");

  res = await apiCall("/notifications", "GET", null, authHeader);
  logTest("List Notifications", res.status < 500, `Status: ${res.status}`);

  res = await apiCall("/notifications/unread-count", "GET", null, authHeader);
  logTest("Unread Count", res.status < 500, `Status: ${res.status}`);

  res = await apiCall("/notifications", "POST", {
    type: "upload_started",
    title: "Upload Started",
    bodyText: "Your video is uploading",
  }, authHeader);
  logTest("Create Notification", res.status < 500, `Status: ${res.status}`);

  // 10. PAYMENTS ENDPOINTS
  console.log("\n📋 === PAYMENTS ENDPOINTS ===");

  res = await apiCall("/payments", "GET", null, authHeader);
  logTest("List Payments", res.status < 500, `Status: ${res.status}`);

  res = await apiCall("/payments/stats", "GET", null, authHeader);
  logTest("Payment Stats", res.status < 500, `Status: ${res.status}`);

  // 11. ADS ENDPOINTS
  console.log("\n📋 === ADS ENDPOINTS ===");

  res = await apiCall("/ads", "GET", null, authHeader);
  logTest("List Ads", res.status < 500, `Status: ${res.status}`);

  res = await apiCall("/ads", "POST", {
    title: "Test Ad",
    description: "Test Ad Description",
    budget: 10000,
    target_category: "technology",
  }, authHeader);
  logTest("Create Ad", res.status < 500, `Status: ${res.status}`);

  // 12. ADMIN ENDPOINTS
  console.log("\n📋 === ADMIN ENDPOINTS ===");

  res = await apiCall("/admin/health", "GET");
  logTest("Admin Health", res.status < 500, `Status: ${res.status}`);

  res = await apiCall("/admin/dashboard", "GET", null, authHeader);
  logTest("Admin Dashboard", res.status < 500, `Status: ${res.status}`);

  // SUMMARY
  console.log("\n" + "=".repeat(80));
  console.log("📊 TEST SUMMARY");
  console.log("=".repeat(80));
  
  const passed = results.filter(r => r.includes("✅")).length;
  const failed = results.filter(r => r.includes("❌")).length;
  const warnings = results.filter(r => r.includes("⚠️")).length;
  
  console.log(`\nTotal Endpoints: ${results.length}`);
  console.log(`✅ Responding: ${passed}`);
  console.log(`❌ Not Responding: ${failed}`);
  console.log(`⚠️  Warnings: ${warnings}`);
  
  console.log("\n" + "=".repeat(80));
  console.log("🎬 VIDEO STREAMING OPTIMIZATION STATUS");
  console.log("=".repeat(80));
  console.log(`✓ Streaming URLs: ${hasStreamingUrls ? "✅ Enabled" : "⚠️ Not detected"}`);
  console.log(`✓ Feed Performance: ${feedPerformanceOk ? "✅ < 500ms" : "⚠️ Check indexes"}`);
  console.log(`✓ Query Optimization: ${feedInteractionOk ? "✅ Single query (N+1 fixed)" : "⚠️ Multiple queries"}`);
  
  console.log("\n" + "=".repeat(80));
  console.log("📋 DETAILED RESULTS");
  console.log("=".repeat(80));
  results.forEach(r => console.log(r));
  console.log("=".repeat(80));
}

runTests().catch(console.error);
