const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer'); // For handling file uploads from UploadScreen
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');
require('dotenv').config();

// Generic Email Transporter setup (Configured via .env, fallback to mock if missing)
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || "smtp.example.com",
  port: process.env.SMTP_PORT || 587,
  secure: process.env.SMTP_SECURE === 'true', 
  auth: {
    user: process.env.SMTP_USER || "test@example.com",
    pass: process.env.SMTP_PASS || "password",
  },
});

const app = express();

// Security HTTP headers
app.use(helmet());

// Rate Limiter: Max 100 API requests per 15 minutes per IP address
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100,
  message: { success: false, message: 'Too many requests from this IP, please try again later.' }
});
app.use('/api/', limiter);

app.use(express.json());
app.use(require('cors')());

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Health check endpoints for warm-up pings & uptime monitors
app.get(['/health', '/api/health'], (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// Service-role client: bypasses RLS for trusted server-side operations
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY
);

// Auth Middleware (Verifies Supabase JWT for protected routes)
const { requireAuth, optionalAuth } = require('./middleware/auth');

const upload = multer({ storage: multer.memoryStorage() });

// --- FIREBASE ADMIN INITIALIZATION ---
try {
  // We expect a service account JSON path in .env
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    const serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
    
    // Safety check: Ensure this is a REAL Service Account Key and not google-services.json
    if (!serviceAccount.project_id || !serviceAccount.private_key) {
      throw new Error("Invalid Service Account JSON. Please use the 'Private Key' from Firebase Console -> Service Accounts.");
    }

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin initialized successfully.");
  } else {
    console.warn("FIREBASE_SERVICE_ACCOUNT_PATH not found in .env. Notifications will be disabled.");
  }
} catch (error) {
  console.error("Firebase Admin Init Error:", error.message);
}

// Helper to send push notifications
const sendNotification = async (userId, title, body) => {
  try {
    // 1. Get the latest FCM token for this user
    const { data: device, error } = await supabase
      .from('user_devices')
      .select('fcm_token')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !device?.fcm_token) {
      console.log(`No FCM token found for user ${userId}. Skipping notification.`);
      return;
    }

    // 2. Send the message
    const message = {
      notification: { title, body },
      token: device.fcm_token
    };

    const response = await admin.messaging().send(message);
    console.log(`Successfully sent notification to user ${userId}:`, response);
  } catch (err) {
    console.error(`Error sending notification to user ${userId}:`, err.message);
  }
};

// Helper to escape HTML special characters for Telegram HTML mode
const escapeHtml = (str) => {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
};

// Helper to send Telegram message to admin
const sendTelegramMessage = async (text) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!botToken || botToken === 'YOUR_TELEGRAM_BOT_TOKEN' || !chatId || chatId === 'YOUR_ADMIN_CHAT_ID') {
    console.warn('[TELEGRAM] Bot token or chat ID not configured. Skipping Telegram notification.');
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    });
    const result = await response.json();
    if (result.ok) {
      console.log('[TELEGRAM] Message sent successfully to admin.');
    } else {
      console.error('[TELEGRAM] HTML send failed:', result.description, '. Retrying plain text...');
      // Fallback to plain text if Telegram rejected HTML formatting
      const plainText = text.replace(/<[^>]*>/g, '');
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: plainText,
        }),
      });
    }
  } catch (err) {
    console.error('[TELEGRAM] Error sending message:', err.message);
  }
};

// Helper to send Telegram message WITH inline keyboard buttons
const sendTelegramMessageWithButtons = async (text, inlineKeyboard) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!botToken || botToken === 'YOUR_TELEGRAM_BOT_TOKEN' || !chatId || chatId === 'YOUR_ADMIN_CHAT_ID') {
    console.warn('[TELEGRAM] Bot token or chat ID not configured. Skipping Telegram notification.');
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
        reply_markup: { inline_keyboard: inlineKeyboard },
      }),
    });
    const result = await response.json();
    if (result.ok) {
      console.log('[TELEGRAM] Message with buttons sent successfully to admin.');
    } else {
      console.error('[TELEGRAM] HTML send with buttons failed:', result.description, '. Retrying plain text...');
      const plainText = text.replace(/<[^>]*>/g, '');
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: plainText,
          reply_markup: { inline_keyboard: inlineKeyboard },
        }),
      });
    }
  } catch (err) {
    console.error('[TELEGRAM] Error sending message with buttons:', err.message);
  }
};

// Helper to send the actual document file directly to Telegram chat
const sendTelegramDocument = async (fileUrl, caption) => {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

  if (!botToken || !chatId) return;

  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        document: fileUrl,
        caption: caption || '📎 Customer Document File',
      }),
    });
    const result = await response.json();
    if (result.ok) {
      console.log('[TELEGRAM] Document file attached and sent to admin.');
    } else {
      console.error('[TELEGRAM] Failed to send document file:', result.description);
    }
  } catch (err) {
    console.error('[TELEGRAM] Error sending document file:', err.message);
  }
};


// Helper to count PDF pages from buffer
function countPagesFromBuffer(fileBuffer, mimetype, originalname) {
  try {
    const filename = (originalname || '').toLowerCase();
    const mime = (mimetype || '').toLowerCase();
    if (mime.includes('pdf') || filename.endsWith('.pdf')) {
      const content = fileBuffer.toString('binary');
      // Method 1: Count occurrences of /Type /Page (excluding /Pages)
      const pageMatches = content.match(/\/Type\s*\/Page\b/g);
      if (pageMatches && pageMatches.length > 0) {
        return pageMatches.length;
      }
      // Method 2: Fallback to /Count N in Pages dict
      const countMatch = content.match(/\/Count\s+(\d+)/);
      if (countMatch && countMatch[1]) {
        return parseInt(countMatch[1], 10);
      }
    }
  } catch (err) {
    console.error('[PAGE COUNT ERROR]', err);
  }
  return 0;
}


// --- AUTHENTICATION ---

// Register User (Connects to register_screen.dart)
app.post('/api/register', async (req, res) => {
  const { email, password, fullName } = req.body;
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName, role: 'customer' } }
  });
  if (error) return res.status(400).json(error);
  res.json({ message: "Verification OTP sent!", data });
});

// Login User (Connects to login_screen.dart)
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return res.status(401).json(error);
  res.json(data);
});

// Current authenticated user session details
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', req.userId)
      .maybeSingle();

    res.json({
      success: true,
      user: {
        id: req.user.id,
        email: req.user.email,
        phone: req.user.phone,
        metadata: req.user.user_metadata,
        profile: profile || null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// --- NOTIFICATIONS DOMAIN (Protected) ---

// 1. Fetch user notifications
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('[NOTIFICATIONS FETCH ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch notifications', error: err.message });
  }
});

// 2. Mark single notification as read
app.patch('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('id', id)
      .eq('user_id', req.userId)
      .select()
      .maybeSingle();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error('[NOTIFICATION MARK READ ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Failed to update notification', error: err.message });
  }
});

// 3. Mark all notifications as read
app.post('/api/notifications/mark-all-read', requireAuth, async (req, res) => {
  try {
    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.userId)
      .eq('is_read', false);

    if (error) throw error;
    res.json({ success: true, message: 'All notifications marked as read' });
  } catch (err) {
    console.error('[NOTIFICATIONS MARK ALL READ ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Failed to mark all as read', error: err.message });
  }
});

// 4. Register Device FCM Token
app.post('/api/notifications/register-device', requireAuth, async (req, res) => {
  try {
    const { fcmToken, platform } = req.body;
    if (!fcmToken) {
      return res.status(400).json({ success: false, message: 'fcmToken is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('user_devices')
      .upsert({
        user_id: req.userId,
        fcm_token: fcmToken,
        platform: platform || 'android',
        updated_at: new Date().toISOString(),
      }, { onConflict: 'fcm_token' });

    if (error) throw error;
    res.json({ success: true, message: 'Device token registered successfully' });
  } catch (err) {
    console.error('[DEVICE TOKEN REGISTER ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Failed to register device', error: err.message });
  }
});

// --- PROFILE & SETTINGS DOMAIN (Protected) ---

// 1. Get user profile
app.get('/api/profile', requireAuth, async (req, res) => {
  try {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', req.userId)
      .maybeSingle();

    const { data: customer } = await supabaseAdmin
      .from('customer_accounts')
      .select('*')
      .eq('id', req.userId)
      .maybeSingle();

    res.json({
      success: true,
      data: {
        id: req.userId,
        email: req.user.email,
        phone: req.user.phone || customer?.phone || profile?.phone,
        fullName: profile?.full_name || customer?.full_name || req.user.user_metadata?.full_name,
        role: profile?.role || 'customer',
        accountType: customer?.account_type || profile?.role || 'personal',
        loyaltyPoints: customer?.loyalty_points || 0,
        status: profile?.status || 'Active',
      },
    });
  } catch (err) {
    console.error('[GET PROFILE ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch profile', error: err.message });
  }
});

// 2. Update profile / account type
app.patch('/api/profile', requireAuth, async (req, res) => {
  try {
    const { fullName, phone, accountType } = req.body;

    const updates = {};
    if (fullName) updates.full_name = fullName;
    if (phone) updates.phone = phone;

    if (Object.keys(updates).length > 0) {
      await supabaseAdmin.from('profiles').update(updates).eq('id', req.userId);
      await supabaseAdmin.from('customer_accounts').update(updates).eq('id', req.userId);
    }

    if (accountType) {
      if (accountType === 'translator') {
        await supabaseAdmin.from('profiles').upsert({
          id: req.userId,
          email: req.user.email,
          full_name: fullName || req.user.user_metadata?.full_name || req.user.email,
          role: 'translator',
          status: 'Approved',
        }, { onConflict: 'id' });
      } else {
        await supabaseAdmin.from('customer_accounts').upsert({
          id: req.userId,
          account_type: accountType,
        }, { onConflict: 'id' });
      }
    }

    res.json({ success: true, message: 'Profile updated successfully' });
  } catch (err) {
    console.error('[UPDATE PROFILE ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Failed to update profile', error: err.message });
  }
});

// --- TRANSLATION SERVICES ---

// Get All Companies / Translators (Connects to home_screen.dart)
app.get('/api/companies', async (req, res) => {
  try {
    const { data: translators, error } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('role', 'translator');

    if (error) throw error;

    let ratings = [];
    try {
      const { data: ratingsData } = await supabaseAdmin
        .from('translator_ratings_view')
        .select('*');
      ratings = ratingsData || [];
    } catch (_) {}

    const merged = (translators || []).map((t) => {
      const r = ratings.find((item) => item.translator_id === t.id);
      return {
        ...t,
        avg_rating: r?.average_rating || 5.0,
        review_count: r?.review_count || 0,
      };
    });

    res.json({ success: true, data: merged });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// Upload Document for Translation (Connects to upload_screen.dart)
// Legacy endpoint — kept for compatibility
app.post('/api/jobs/upload', upload.single('document'), async (req, res) => {
  const { userId, companyId } = req.body;
  const file = req.file;

  // 1. Upload file to Supabase Storage
  const fileName = `${Date.now()}_${file.originalname}`;
  const { data: storageData, error: storageError } = await supabase.storage
    .from('documents')
    .upload(`user_${userId}/${fileName}`, file.buffer);

  if (storageError) return res.status(500).json(storageError);

  // 2. Create Job Entry in Database
  const { data: jobData, error: jobError } = await supabase.from('jobs').insert([{
    client_id: userId,
    translator_id: companyId,
    document_url: storageData.path,
    status: 'pending'
  }]);

  if (jobError) return res.status(500).json(jobError);

  res.json({ message: "Job created successfully!", jobData });
});

// ─────────────────────────────────────────────────────────────────────────────
// NEW: Submit Job with Telegram Admin Notification + Auto-Pricing
// Called by upload_screen.dart (Flutter) instead of the direct Supabase insert
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/jobs/submit-with-notify', upload.single('document'), async (req, res) => {
  const { userId, translatorId, merchantName, fromLang, toLang, urgency, pageCount, isHandwritten, isMedical, customerPhone: providedPhone, deliveryType } = req.body;
  const file = req.file;
  const handwritten = isHandwritten === 'true' || isHandwritten === true;
  const medical = isMedical === 'true' || isMedical === true;
  const delivery = deliveryType || 'Soft Copy';

  // --- Validation ---
  if (!userId || !fromLang || !toLang || !file || !pageCount) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  const pages = parseInt(pageCount, 10);
  if (isNaN(pages) || pages < 1) {
    return res.status(400).json({ success: false, message: 'Invalid page count.' });
  }

  try {
    // ── STEP 1: Upload file to Supabase Storage (service role bypasses RLS) ──
    const fileName = `${Date.now()}_${file.originalname}`;
    const filePath = `jobs/${userId}/${fileName}`;

    console.log(`[STEP 1] Uploading file: ${fileName} (${file.size} bytes)`);
    const { data: storageData, error: storageError } = await supabaseAdmin.storage
      .from('translations')
      .upload(filePath, file.buffer, {
        contentType: file.mimetype,
        upsert: false,
      });

    if (storageError) {
      console.error('[STEP 1 FAIL] Storage upload error:', storageError.message, storageError);
      return res.status(500).json({ success: false, message: 'File upload failed.', error: storageError.message });
    }
    console.log('[STEP 1 OK] File uploaded:', storageData.path);

    // Build a public URL for the file so admin can open it in Telegram
    const { data: publicUrlData } = supabaseAdmin.storage
      .from('translations')
      .getPublicUrl(filePath);
    const filePublicUrl = publicUrlData?.publicUrl || filePath;
    console.log('[STEP 1 OK] Public URL:', filePublicUrl);

    // ── STEP 2: Count pages & cross-check with customer page count ─────────────
    const detectedPages = countPagesFromBuffer(file.buffer, file.mimetype, file.originalname);
    const providedPages = parseInt(pageCount, 10) || 1;
    let pages = providedPages;

    if (detectedPages > 0) {
      pages = Math.max(detectedPages, providedPages);
      console.log(`[PAGE COUNT] Customer provided: ${providedPages} | Backend detected: ${detectedPages} | Decided: ${pages}`);
    } else {
      console.log(`[PAGE COUNT] Customer provided: ${providedPages} | Backend detected: N/A | Decided: ${pages}`);
    }

    // Helpers to classify languages for auto-pricing
    const isAfarOrSomali = (lang) => {
      if (!lang) return false;
      const l = String(lang).trim().toLowerCase();
      return l.includes('afar') || l.includes('somali') || l.includes('ሶማሊ') || l.includes('ዓፋር');
    };

    const isLocalLang = (lang) => {
      if (!lang) return false;
      const l = String(lang).trim().toLowerCase();
      return (
        l.includes('amharic') || l.includes('አማርኛ') ||
        l.includes('english') ||
        l.includes('orom') || l.includes('oromiffa') || l.includes('afaan') ||
        l.includes('tigr') || l.includes('tigray') ||
        l.includes('arabic') || l.includes('ዓረብኛ') ||
        l.includes('sidama') || l.includes('wolayta') || l.includes('wolaytta') ||
        isAfarOrSomali(l)
      );
    };

    const hasAfarOrSomali = isAfarOrSomali(fromLang) || isAfarOrSomali(toLang);
    const isLocalPair     = isLocalLang(fromLang) && isLocalLang(toLang);

    // Rate calculation based on category & languages:
    // - Local Pair General (Amharic, English, Oromiffa, Tigray, Sidama, Wolayta, Arabic): 250 Birr / page
    // - Afar / Somali General: 400 Birr / page
    // - Local Pair Medical: 400 Birr / page
    // - Foreign Pair General: 500 Birr / page
    // - Foreign Pair Medical: 550 Birr / page
    let pricePerPage;
    if (medical) {
      pricePerPage = isLocalPair ? 400 : 550;
    } else if (hasAfarOrSomali) {
      pricePerPage = isLocalPair ? 400 : 500;
    } else {
      pricePerPage = isLocalPair ? 250 : 500;
    }

    const feePercent     = parseFloat(process.env.SERVICE_FEE_PERCENT || '20');
    const basePrice      = pages * pricePerPage;
    const serviceFee     = basePrice * (feePercent / 100);
    const totalPrice     = basePrice + serviceFee; // Urgency fee removed from calculation
    console.log(`[STEP 2 OK] Pricing - Pages: ${pages} | Medical: ${medical} | Pair: ${fromLang}->${toLang} (Local: ${isLocalPair}, Afar/Somali: ${hasAfarOrSomali}) | Rate: ${pricePerPage} ETB/pg | Base: ${basePrice} | Fee: ${serviceFee} | Total: ${totalPrice}`);

    // ── STEP 3: Fetch customer info from DB ───────────────────────────────────
    let customerName = 'Unknown Customer';
    // Phone: use what the customer typed during upload as the primary source
    let customerPhone = (providedPhone && providedPhone.trim()) ? providedPhone.trim() : 'N/A';

    const { data: profile } = await supabase
      .from('customer_accounts')
      .select('full_name, phone')
      .eq('id', userId)
      .maybeSingle();

    if (profile) {
      customerName  = profile.full_name  || profile.email || customerName;
      // Only override phone from DB if customer didn't provide one
      if (customerPhone === 'N/A') customerPhone = profile.phone || customerPhone;
    } else {
      // Fallback: try profiles table
      const { data: profile2 } = await supabase
        .from('profiles')
        .select('full_name, phone')
        .eq('id', userId)
        .maybeSingle();
      if (profile2) {
        customerName  = profile2.full_name  || customerName;
        customerPhone = profile2.phone      || customerPhone;
      }
    }

    // ── STEP 4: Insert job into DB (using service role to bypass RLS) ────────────────────────────────────────────
    const jobRow = {
      client_id:      userId,
      from_lang:      fromLang,
      to_lang:        toLang,
      file_url:       filePublicUrl,
      status:         handwritten ? 'Awaiting Review' : 'pending',
      price:          totalPrice,
      page_count:     pages,
      urgency:        urgency || 'Normal',
      is_handwritten: handwritten || false,
      is_medical:     medical,
      client_phone:   customerPhone !== 'N/A' ? customerPhone : null,
      delivery_type:  delivery,
      created_at:     new Date().toISOString(),
    };
    // Only set translator_id if it's a valid UUID (reject display-only string IDs like 'wisdom-002')
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (translatorId && uuidRegex.test(translatorId)) jobRow.translator_id = translatorId;

    const { data: job, error: jobError } = await supabaseAdmin
      .from('jobs')
      .insert([jobRow])
      .select()
      .single();

    if (jobError) {
      console.error('[STEP 4 FAIL] Job insert error code:', jobError.code);
      console.error('[STEP 4 FAIL] Job insert error msg:', jobError.message);
      console.error('[STEP 4 FAIL] Job insert details:', jobError.details);
      console.error('[STEP 4 FAIL] Full error:', JSON.stringify(jobError));
      return res.status(500).json({ success: false, message: 'Failed to create job record.', error: jobError.message, code: jobError.code });
    }
    console.log('[STEP 4 OK] Job created:', job.id);

    const urgencyEmoji = urgency === 'Urgent' ? '🚨' : urgency === 'Super Urgent' ? '🔥' : '🟢';
    const selectedMerchant = merchantName || 'General Marketplace';
    const handwrittenLine = handwritten ? '\nType: Handwritten' : '';
    const medicalLine = medical ? '\nCategory: Medical Document' : '\nCategory: General Document';
    const deliveryLine = `\nDelivery: ${delivery}`;

    // ── STEP 5: Send Dual Telegram Notifications ─────────────────────────────
    
    // 1. ADMIN MESSAGE (Full details with phone & merchant name)
    const adminTelegramMessage =
`[NEW ORDER - ADMIN]
Merchant: ${selectedMerchant}
Language: ${fromLang} -> ${toLang}${medicalLine}
Pages: ${pages}
Price: ${totalPrice.toFixed(2)} ETB
Urgency: ${urgency || 'Normal'}${deliveryLine}${handwrittenLine}
Phone: ${customerPhone}
File: ${filePublicUrl}`;

    // 2. TRANSLATOR MESSAGE (Clean forward copy — NO customer phone, NO merchant name)
    const translatorTelegramMessage =
`[NEW ORDER - TRANSLATOR]
Language: ${fromLang} -> ${toLang}${medicalLine}
Pages: ${pages}
Price: ${totalPrice.toFixed(2)} ETB
Urgency: ${urgency || 'Normal'}${deliveryLine}${handwrittenLine}
File: ${filePublicUrl}`;

    // For handwritten docs: add inline Accept / Reject buttons to Admin message
    if (handwritten) {
      await sendTelegramMessageWithButtons(adminTelegramMessage, [
        [
          { text: 'Accept', callback_data: `accept_${job.id}` },
          { text: 'Reject', callback_data: `reject_${job.id}` },
        ]
      ]);
    } else {
      await sendTelegramMessage(adminTelegramMessage);
    }

    // Send the anonymized forward copy for the translator
    await sendTelegramMessage(translatorTelegramMessage);

    // Send the actual file attachment to Telegram chat
    await sendTelegramDocument(filePublicUrl, `Document: ${file.originalname}`);

    // ── STEP 6: Return job to Flutter ────────────────
    res.json({
      success: true,
      message: 'Job submitted successfully!',
      data: {
        id:         job.id,
        status:     job.status,
        from_lang:  job.from_lang,
        to_lang:    job.to_lang,
        file_url:   job.file_url,
        urgency:    job.urgency,
        page_count: pages,
        price:      totalPrice,
        created_at: job.created_at,
      },
    });

  } catch (error) {
    console.error('[submit-with-notify] Error:', error);
    res.status(500).json({ success: false, message: 'Internal server error.', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/jobs/notify-telegram
// Called by upload_screen.dart fallback to send Dual Telegram notices + file URL
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/jobs/notify-telegram', async (req, res) => {
  try {
    const { jobId, merchantName, fromLang, toLang, pages, urgency, isHandwritten, customerPhone, fileUrl, fileName, deliveryType } = req.body;

    const handwrittenLine = (isHandwritten === true || isHandwritten === 'true') ? '\nType: Handwritten' : '';
    const selectedMerchant = merchantName || 'General Marketplace';
    const nameStr = fileName || 'Document File';
    const delivery = deliveryType || 'Soft Copy';
    const deliveryLine = `\nDelivery: ${delivery}`;

    const adminMessage =
`[NEW ORDER - ADMIN]
Merchant: ${selectedMerchant}
Language: ${fromLang || 'N/A'} -> ${toLang || 'N/A'}
Pages: ${pages || 1}
Phone: ${customerPhone || 'N/A'}
Urgency: ${urgency || 'Normal'}${deliveryLine}${handwrittenLine}
File: ${fileUrl}`;

    const translatorMessage =
`[NEW ORDER - TRANSLATOR]
Language: ${fromLang || 'N/A'} -> ${toLang || 'N/A'}
Pages: ${pages || 1}
Urgency: ${urgency || 'Normal'}${deliveryLine}${handwrittenLine}
File: ${fileUrl}`;

    // Immediately respond to caller so mobile app does not wait on Telegram network roundtrips
    res.json({ success: true, message: 'Dual Telegram notifications queued.' });

    // Send notifications in the background
    (async () => {
      try {
        if (isHandwritten === true || isHandwritten === 'true') {
          await sendTelegramMessageWithButtons(adminMessage, [
            [
              { text: 'Accept', callback_data: `accept_${jobId}` },
              { text: 'Reject', callback_data: `reject_${jobId}` },
            ]
          ]);
        } else {
          await sendTelegramMessage(adminMessage);
        }

        // Send forwardable translator copy
        await sendTelegramMessage(translatorMessage);

        if (fileUrl) {
          await sendTelegramDocument(fileUrl, `Document: ${nameStr}`);
        }
      } catch (bgErr) {
        console.error('[notify-telegram BG ERROR]', bgErr.message);
      }
    })();
  } catch (err) {
    console.error('[notify-telegram] Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payments/verify-and-update
// Customer submits transaction reference and/or receipt screenshot
// Updates job status to 'Awaiting Verification' & notifies Telegram admin bot!
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/payments/verify-and-update', upload.single('screenshot'), async (req, res) => {
  try {
    const { jobId, transactionRef } = req.body;
    const screenshotFile = req.file;

    if (!jobId || (!transactionRef && !screenshotFile)) {
      return res.status(400).json({
        success: false,
        message: 'Please provide a transaction reference or upload a receipt screenshot.'
      });
    }

    console.log(`[PAYMENT VERIFY] Job: ${jobId} | Ref: ${transactionRef || 'N/A'}`);

    // 1. Fetch job from DB
    const { data: job, error: jobFetchErr } = await supabaseAdmin
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (jobFetchErr || !job) {
      return res.status(404).json({ success: false, message: 'Job not found.' });
    }

    // 2. Upload receipt screenshot if provided
    let screenshotUrl = null;
    if (screenshotFile) {
      const ext = screenshotFile.originalname.split('.').pop() || 'png';
      const screenshotPath = `receipts/${jobId}_${Date.now()}.${ext}`;

      let { error: uploadErr } = await supabaseAdmin.storage
        .from('translations')
        .upload(screenshotPath, screenshotFile.buffer, {
          contentType: screenshotFile.mimetype,
          upsert: true,
        });

      if (uploadErr) {
        console.warn('[PAYMENT] Storage upload to translations bucket error, trying payments bucket:', uploadErr.message);
        const retry = await supabaseAdmin.storage
          .from('payments')
          .upload(screenshotPath, screenshotFile.buffer, {
            contentType: screenshotFile.mimetype,
            upsert: true,
          });
        uploadErr = retry.error;
        if (!uploadErr) {
          const { data: pubData } = supabaseAdmin.storage
            .from('payments')
            .getPublicUrl(screenshotPath);
          screenshotUrl = pubData?.publicUrl || screenshotPath;
        }
      } else {
        const { data: pubData } = supabaseAdmin.storage
          .from('translations')
          .getPublicUrl(screenshotPath);
        screenshotUrl = pubData?.publicUrl || screenshotPath;
      }

      if (uploadErr) {
        console.error('[PAYMENT] Receipt screenshot upload error:', uploadErr.message);
      }
    }

    // 3. Update job status in DB
    const updatePayload = {
      status: 'awaiting verification',
      transaction_ref: transactionRef || job.transaction_ref || null,
    };
    if (screenshotUrl) {
      updatePayload.receipt_url = screenshotUrl;
    }

    const { error: updateErr } = await supabaseAdmin
      .from('jobs')
      .update(updatePayload)
      .eq('id', jobId);

    if (updateErr) {
      console.error('[PAYMENT] DB update failed:', updateErr.message);
      return res.status(500).json({ success: false, message: 'Failed to update job payment status.' });
    }

    // 4. Send Telegram notification to Admin
    const shortId = String(job.id).substring(0, 8).toUpperCase();
    const priceText = job.price ? `${job.price} ETB` : 'Quoted Price';
    const refDisplay = transactionRef ? `<code>${transactionRef}</code>` : 'Receipt Screenshot Uploaded';

    const telegramMessage =
`[PAYMENT SUBMITTED FOR REVIEW]

Job ID: #${shortId}
Languages: ${job.from_lang} -> ${job.to_lang}
Pages: ${job.page_count || 1}
Price: ${priceText}
Ref: ${transactionRef || 'Screenshot uploaded'}
Phone: ${job.client_phone || 'N/A'}
File: ${job.file_url}
${screenshotUrl ? `Receipt: ${screenshotUrl}` : ''}

Tap Approve or Reject below:`;

    const inlineKeyboard = [
      [
        { text: 'Approve Payment', callback_data: `approve_pay_${job.id}` },
        { text: 'Reject Payment', callback_data: `reject_pay_${job.id}` },
      ]
    ];

    // Respond to user immediately after database update
    res.json({
      success: true,
      message: 'Payment verification submitted! Admin notified on Telegram.',
    });

    // Send Telegram notification in background
    (async () => {
      try {
        await sendTelegramMessageWithButtons(telegramMessage, inlineKeyboard);
        if (screenshotUrl) {
          await sendTelegramDocument(screenshotUrl, `Receipt Screenshot - Job #${shortId}`);
        }
      } catch (bgErr) {
        console.error('[PAYMENT TELEGRAM BG ERROR]', bgErr.message);
      }
    })();

  } catch (err) {
    console.error('[PAYMENT VERIFY ERROR]', err);
    res.status(500).json({ success: false, message: 'Internal server error.', error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM BOT WEBHOOK & LONG-POLLING BUTTON HANDLER
// Handles admin [✅ Approve Payment], [❌ Reject Payment], [Accept], [Reject] taps
// ─────────────────────────────────────────────────────────────────────────────

// Helper to acknowledge a Telegram callback query
const answerCallbackQuery = async (callbackQueryId, text, botToken) => {
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: true }),
    });
  } catch (e) {
    console.error('[TELEGRAM] answerCallbackQuery failed:', e.message);
  }
};

// Unified Callback Query Handler
const handleTelegramCallbackQuery = async (callback) => {
  const callbackData = callback.data || '';
  const callbackQueryId = callback.id;
  const botToken = process.env.TELEGRAM_BOT_TOKEN;

  if (!callbackData || !botToken) return;

  console.log(`[TELEGRAM BUTTON TAP] Received button tap: "${callbackData}"`);

  // 1. Payment approval/rejection buttons: approve_pay_<jobId> / reject_pay_<jobId>
  if (callbackData.startsWith('approve_pay_') || callbackData.startsWith('reject_pay_')) {
    const isApprove = callbackData.startsWith('approve_pay_');
    const rawJobId = callbackData.replace('approve_pay_', '').replace('reject_pay_', '');
    const targetId = isNaN(Number(rawJobId)) ? rawJobId : Number(rawJobId);
    const newStatus = isApprove ? 'In Progress' : 'Awaiting Payment';

    try {
      const { error: err } = await supabaseAdmin
        .from('jobs')
        .update({ status: newStatus })
        .eq('id', targetId);

      if (err) {
        console.error('[TELEGRAM] Supabase update error:', err.message);
        await answerCallbackQuery(callbackQueryId, `❌ DB Error: ${err.message}`, botToken);
        return;
      }

      console.log(`[TELEGRAM SUCCESS] Job #${targetId} updated to "${newStatus}" by admin button tap.`);

      const ackText = isApprove ? 'Payment Approved. Job is now In Progress.' : 'Payment Rejected.';
      await answerCallbackQuery(callbackQueryId, ackText, botToken);

      // Send a follow-up confirmation message (avoids editMessageText HTML conflicts)
      const confirmMsg = isApprove
        ? `[APPROVED] Job #${String(targetId).substring(0, 8).toUpperCase()} payment approved. Status: In Progress.`
        : `[REJECTED] Job #${String(targetId).substring(0, 8).toUpperCase()} payment rejected. Status: Awaiting Payment.`;
      await sendTelegramMessage(confirmMsg);
    } catch (err) {
      console.error('[TELEGRAM ERROR]', err.message);
      await answerCallbackQuery(callbackQueryId, '❌ Error processing payment decision.', botToken);
    }
    return;
  }

  // 2. Handwritten document accept/reject buttons: accept_<jobId> / reject_<jobId>
  if (callbackData.startsWith('accept_') || callbackData.startsWith('reject_')) {
    const isAccept = callbackData.startsWith('accept_');
    const rawJobId = callbackData.replace('accept_', '').replace('reject_', '');
    const targetId = isNaN(Number(rawJobId)) ? rawJobId : Number(rawJobId);
    const newStatus = isAccept ? 'pending' : 'Rejected';

    try {
      const updatePayload = { status: newStatus };
      if (!isAccept) updatePayload.rejection_reason = 'Admin reviewed and rejected this handwritten document.';

      const { error: updateError } = await supabaseAdmin
        .from('jobs')
        .update(updatePayload)
        .eq('id', targetId);

      if (updateError) {
        console.error('[TELEGRAM] Failed to update job:', updateError.message);
        await answerCallbackQuery(callbackQueryId, '❌ DB update failed.', botToken);
        return;
      }

      console.log(`[TELEGRAM SUCCESS] Job #${targetId} marked as "${newStatus}".`);

      const ackText = isAccept ? 'Order accepted. Customer notified!' : 'Order rejected.';
      await answerCallbackQuery(callbackQueryId, ackText, botToken);

      const confirmMsg = isAccept
        ? `[ACCEPTED] Job #${String(targetId).substring(0, 8).toUpperCase()} handwritten doc accepted. Status: pending.`
        : `[REJECTED] Job #${String(targetId).substring(0, 8).toUpperCase()} handwritten doc rejected.`;
      await sendTelegramMessage(confirmMsg);
    } catch (err) {
      console.error('[TELEGRAM ERROR]', err.message);
    }
  }
};

// Webhook endpoint
app.post('/api/telegram/webhook', async (req, res) => {
  res.sendStatus(200);
  if (req.body?.callback_query) {
    await handleTelegramCallbackQuery(req.body.callback_query);
  }
});

// Telegram Long-Polling for local/dev & production without Webhooks
let lastUpdateId = 0;
async function pollTelegramUpdates() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken || botToken === 'YOUR_TELEGRAM_BOT_TOKEN') return;

  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`);
    const data = await res.json();

    if (data.ok && Array.isArray(data.result)) {
      for (const update of data.result) {
        lastUpdateId = Math.max(lastUpdateId, update.update_id);
        if (update.callback_query) {
          await handleTelegramCallbackQuery(update.callback_query);
        }
      }
    }
  } catch (err) {
    // Suppress transient poll network errors
  }

  setTimeout(pollTelegramUpdates, 1500);
}

// Start polling on server start
pollTelegramUpdates();

// --- JOBS ---

// Get Jobs for Current User (Client or Translator)
app.get('/api/jobs', optionalAuth, async (req, res) => {
  try {
    const targetUserId = req.userId || req.query.userId || req.headers['x-user-id'];
    if (!targetUserId) {
      return res.status(401).json({ success: false, message: 'Authentication required to list jobs' });
    }

    // Check if requester is translator/admin
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', targetUserId)
      .maybeSingle();

    let query = supabaseAdmin
      .from('jobs')
      .select('*')
      .order('created_at', { ascending: false });

    if (profile?.role === 'translator') {
      // Translators see their assigned jobs or unassigned pending jobs
      query = query.or(`translator_id.eq.${targetUserId},status.eq.pending`);
    } else if (profile?.role !== 'admin') {
      // Regular customer
      query = query.or(`client_id.eq.${targetUserId},user_id.eq.${targetUserId}`);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ success: true, data: data || [] });
  } catch (err) {
    console.error('[GET JOBS ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch jobs', error: err.message });
  }
});

// Get Single Job Detail
app.get('/api/jobs/:id', optionalAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const targetId = isNaN(Number(id)) ? id : Number(id);

    const { data: job, error } = await supabaseAdmin
      .from('jobs')
      .select('*')
      .eq('id', targetId)
      .maybeSingle();

    if (error || !job) {
      return res.status(404).json({ success: false, message: 'Job not found' });
    }

    res.json({ success: true, data: job });
  } catch (err) {
    console.error('[GET JOB DETAIL ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Failed to fetch job details', error: err.message });
  }
});

// Get All Jobs (Admin)
app.get('/api/admin/jobs', requireAuth, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('jobs')
    .select('*, companies(name)')
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json(error);
  res.json({ success: true, data: data || [] });
});

// Generate signed upload URL for document or image
app.post('/api/jobs/upload-url', requireAuth, async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) {
      return res.status(400).json({ success: false, message: 'filename is required' });
    }

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const storagePath = `jobs/${req.userId}/${Date.now()}_${safeName}`;

    // Create signed upload URL on Supabase storage bucket 'translations'
    const { data, error } = await supabaseAdmin.storage
      .from('translations')
      .createSignedUploadUrl(storagePath);

    if (error) {
      console.error('[SIGNED URL ERROR]', error.message);
      return res.status(500).json({ success: false, message: 'Failed to create upload URL', error: error.message });
    }

    // Generate public URL for database reference
    const { data: publicData } = supabaseAdmin.storage
      .from('translations')
      .getPublicUrl(storagePath);

    res.json({
      success: true,
      signedUrl: data.signedUrl,
      token: data.token,
      path: data.path,
      storagePath,
      fileUrl: publicData?.publicUrl || storagePath,
    });
  } catch (err) {
    console.error('[UPLOAD-URL ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// Submit / Create Job Record with Telegram Notifications
app.post('/api/jobs/create', requireAuth, async (req, res) => {
  try {
    const {
      fileUrl,
      fromLang,
      toLang,
      pageCount,
      urgency,
      isHandwritten,
      isMedical,
      clientPhone,
      deliveryType,
      translatorId,
      merchantName,
      price: clientReportedPrice,
    } = req.body;

    if (!fileUrl || !fromLang || !toLang) {
      return res.status(400).json({ success: false, message: 'fileUrl, fromLang, and toLang are required' });
    }

    const pages = parseInt(pageCount, 10) || 1;
    const handwritten = isHandwritten === true || isHandwritten === 'true';
    const medical = isMedical === true || isMedical === 'true';
    const delivery = deliveryType || 'Soft Copy';

    // Pricing calculation
    const isAfarOrSomali = (l) => {
      if (!l) return false;
      const s = String(l).trim().toLowerCase();
      return s.includes('afar') || s.includes('somali') || s.includes('ሶማሊ') || s.includes('ዓፋር');
    };
    const isLocalLang = (l) => {
      if (!l) return false;
      const s = String(l).trim().toLowerCase();
      return (
        s.includes('amharic') || s.includes('አማርኛ') ||
        s.includes('english') || s.includes('orom') || s.includes('tigr') ||
        s.includes('arabic') || s.includes('sidama') || s.includes('wolayta') ||
        isAfarOrSomali(s)
      );
    };

    const hasAfarOrSomali = isAfarOrSomali(fromLang) || isAfarOrSomali(toLang);
    const isLocalPair = isLocalLang(fromLang) && isLocalLang(toLang);

    let pricePerPage;
    if (medical) {
      pricePerPage = isLocalPair ? 400 : 550;
    } else if (hasAfarOrSomali) {
      pricePerPage = isLocalPair ? 400 : 500;
    } else {
      pricePerPage = isLocalPair ? 250 : 500;
    }

    const feePercent = parseFloat(process.env.SERVICE_FEE_PERCENT || '20');
    const basePrice = pages * pricePerPage;
    const serviceFee = basePrice * (feePercent / 100);
    const serverPrice = basePrice + serviceFee;
    const finalPrice = clientReportedPrice ? Number(clientReportedPrice) : serverPrice;

    // Fetch phone if not provided
    let phone = clientPhone;
    if (!phone || String(phone).trim() === '') {
      const { data: customer } = await supabaseAdmin
        .from('customer_accounts')
        .select('phone')
        .eq('id', req.userId)
        .maybeSingle();
      phone = customer?.phone || req.user.phone || null;
    }

    const jobRow = {
      client_id: req.userId,
      from_lang: fromLang,
      to_lang: toLang,
      file_url: fileUrl,
      status: handwritten ? 'Awaiting Review' : 'pending',
      price: finalPrice,
      page_count: pages,
      urgency: urgency || 'Normal',
      is_handwritten: handwritten,
      is_medical: medical,
      client_phone: phone,
      delivery_type: delivery,
      created_at: new Date().toISOString(),
    };

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (translatorId && uuidRegex.test(translatorId)) {
      jobRow.translator_id = translatorId;
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from('jobs')
      .insert([jobRow])
      .select()
      .single();

    if (jobError) {
      console.error('[CREATE JOB ERROR]', jobError.message);
      return res.status(500).json({ success: false, message: 'Failed to create job record', error: jobError.message });
    }

    // Telegram Admin Notification
    const selectedMerchant = merchantName || 'General Marketplace';
    const adminMsg = `[NEW ORDER - ADMIN]
Merchant: ${selectedMerchant}
Language: ${fromLang} -> ${toLang}
Pages: ${pages}
Price: ${finalPrice.toFixed(2)} ETB
Urgency: ${urgency || 'Normal'}
Delivery: ${delivery}${handwritten ? '\nType: Handwritten' : ''}
Phone: ${phone || 'N/A'}
File: ${fileUrl}`;

    // Return response to mobile client immediately (DB row created)
    res.json({ success: true, data: job });

    // Send Telegram notifications in background
    (async () => {
      try {
        if (handwritten) {
          await sendTelegramMessageWithButtons(adminMsg, [
            [
              { text: 'Accept', callback_data: `accept_${job.id}` },
              { text: 'Reject', callback_data: `reject_${job.id}` },
            ]
          ]);
        } else {
          await sendTelegramMessage(adminMsg);
        }

        if (fileUrl) {
          await sendTelegramDocument(fileUrl, `Document for Order #${job.id}`);
        }
      } catch (tgErr) {
        console.error('[TELEGRAM BG ERROR]', tgErr.message);
      }
    })();
  } catch (err) {
    console.error('[CREATE JOB UNCAUGHT ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// Redeem loyalty points for a job payment
app.post('/api/payments/redeem-points', requireAuth, async (req, res) => {
  try {
    const { jobId, pointsAmount } = req.body;
    if (!jobId || !pointsAmount) {
      return res.status(400).json({ success: false, message: 'jobId and pointsAmount are required' });
    }

    const amount = Number(pointsAmount);

    // Check available loyalty points
    const { data: customer } = await supabaseAdmin
      .from('customer_accounts')
      .select('loyalty_points')
      .eq('id', req.userId)
      .maybeSingle();

    const currentPoints = customer?.loyalty_points || 0;
    if (currentPoints < amount) {
      return res.status(400).json({
        success: false,
        message: `Insufficient loyalty points. You have ${currentPoints}, needed ${amount}.`,
      });
    }

    // Insert redemption request
    await supabaseAdmin.from('point_redemption_requests').insert({
      customer_id: req.userId,
      points_amount: amount,
      job_id: jobId,
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    // Update job status
    const targetId = isNaN(Number(jobId)) ? jobId : Number(jobId);
    const { data: job } = await supabaseAdmin
      .from('jobs')
      .select('status')
      .eq('id', targetId)
      .maybeSingle();

    const currStatus = (job?.status || '').toString().toLowerCase();
    const nextStatus = currStatus === 'awaiting down payment' ? 'down payment verification' : 'awaiting verification';

    await supabaseAdmin
      .from('jobs')
      .update({ status: nextStatus })
      .eq('id', targetId);

    // Telegram notification to admin
    await sendTelegramMessage(`[LOYALTY POINTS REDEMPTION REQUEST]
Customer ID: ${req.userId}
Job ID: #${jobId}
Points: ${amount}
New Status: ${nextStatus}`);

    res.json({ success: true, message: 'Points redemption submitted for admin approval' });
  } catch (err) {
    console.error('[REDEEM POINTS ERROR]', err.message);
    res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// --- PAYMENT VERIFICATION ---

// Verify Payment and Update Job Status (Integrates with verify.leul.et)
app.post('/api/payments/verify-and-update', async (req, res) => {
  const { jobId, transactionRef, suffix } = req.body;
  const apiKey = process.env.VERIFIER_API_KEY;

  if (!jobId || !transactionRef) {
    return res.status(400).json({ success: false, message: "Job ID and Transaction Reference are required." });
  }

  try {
    // 0. Fetch the job details to check the expected price
    const { data: jobData, error: fetchError } = await supabase
      .from('jobs')
      .select('price')
      .eq('id', jobId)
      .single();

    if (fetchError || !jobData) {
      return res.status(404).json({ success: false, message: "Job not found." });
    }

    const expectedAmount = jobData.price;
    if (!expectedAmount || expectedAmount <= 0) {
      return res.status(400).json({ success: false, message: "This job does not have a set price yet." });
    }

    // 1. Priority: Check for MOCK TEST reference first (to allow testing during development)
    let isVerified = false;
    let paymentData = null;

    if (transactionRef.startsWith('TEST')) {
      console.log(`Using MOCK verification logic for Ref: ${transactionRef}`);
      isVerified = true;
      // Mock payment data matches expected amount for testing
      paymentData = { amount: expectedAmount, status: "completed", provider: "Telebirr", receiver: process.env.OFFICIAL_ACCOUNT_NUMBER || "0911373034" };
    } else if (transactionRef.startsWith('FRAUD_TEST')) {
      console.log(`Simulating FRAUD scenario for Ref: ${transactionRef}`);
      isVerified = true;
      // Simulate payment to WRONG receiver
      paymentData = { amount: expectedAmount, status: "completed", provider: "Telebirr", receiver: "0999999999" };
    } else if (!apiKey || apiKey === 'YOUR_MOCK_KEY') {
       console.log(`No API Key found, and reference is not mock. Failing.`);
       return res.status(401).json({ success: false, message: "Verification service not configured." });
    } else {
      // REAL LOGIC: Call verify.leul.et
      console.log(`Calling real verification for Ref: ${transactionRef}`);
      const response = await fetch('https://verify.leul.et/api/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey
        },
        body: JSON.stringify({ reference: transactionRef, suffix })
      });

      const result = await response.json();
      console.log("Real API Result:", JSON.stringify(result));

      if (result.success) {
        // --- 1. FRAUD PREVENTION: Verify Receiver ---
        const officialAccount = process.env.OFFICIAL_ACCOUNT_NUMBER || "0911373034";
        const officialName = process.env.OFFICIAL_ACCOUNT_NAME || "Eyuel Shimelis";
        
        // Potential field names for receiver information from verify.leul.et
        const receiverInfo = result.data?.receiver || result.data?.receiver_number || result.data?.to || "";
        const receiverName = result.data?.receiver_name || result.data?.name || "";

        console.log(`Fraud Check: Official(${officialAccount}) vs Received(${receiverInfo})`);
        
        // If receiver info is available, it MUST match the official account
        if (receiverInfo && !receiverInfo.includes(officialAccount) && !receiverName.includes(officialName)) {
           console.log(`FRAUD DETECTED: Payment sent to ${receiverInfo} (${receiverName}) instead of ${officialAccount}`);
           
           // AUTO-REJECT in Database
           await supabase.from('jobs').update({
             status: 'Rejected',
             rejection_reason: `Fraud Prevention: This payment was sent to an unauthorized account (${receiverInfo}). Please use the official account: ${officialAccount}.`
           }).eq('id', jobId);

           return res.status(403).json({ 
             success: false, 
             message: "Security Alert: Payment was sent to an incorrect receiver account. Automated rejection triggered." 
           });
        }

        // --- 2. SECURITY CHECK: Verify amount matches ---
        const rawAmount = result.data?.totalPaidAmount || result.data?.settledAmount || "0";
        const paidAmount = parseFloat(rawAmount.replace(/[^\d.]/g, ''));
        
        console.log(`Amount Check: Expected ${expectedAmount}, Paid ${paidAmount} (Raw: ${rawAmount})`);

        if (paidAmount && paidAmount >= expectedAmount) {
          isVerified = true;
          paymentData = result.data;
        } else {
          console.log(`Amount Mismatch: Expected ${expectedAmount}, Paid ${paidAmount}`);
          
          // Optional: Auto-reject for amount mismatch too
          await supabase.from('jobs').update({
            status: 'Rejected',
            rejection_reason: `Amount Mismatch: You paid ${paidAmount} ETB, but the required amount is ${expectedAmount} ETB.`
          }).eq('id', jobId);

          return res.status(400).json({ 
            success: false, 
            message: `Payment amount mismatch. Expected ${expectedAmount}, received ${paidAmount || '0'}.` 
          });
        }
      } else {
        console.log(`Verification failed for ${transactionRef}: ${result.message || 'Unknown error'}`);
      }
    }

    if (!isVerified) {
      return res.status(400).json({ success: false, message: "Payment could not be verified." });
    }

    // 2. Update Job Status in Supabase
    // Payment has been verified - move job to 'In Progress' so translator can begin work
    const { data: job, error: jobError } = await supabase
      .from('jobs')
      .update({ 
        status: 'In Progress',
        transaction_ref: transactionRef,
        verified_at: new Date().toISOString()
      })
      .eq('id', jobId)
      .select()
      .single();

    res.json({ 
      success: true, 
      message: "Payment verified and job is now in progress!", 
      data: job,
      paymentInfo: paymentData
    });

    // 3. Send Notifications
    // Fetch client email for Invoice
    try {
      const { data: clientData } = await supabase
        .from('customer_accounts')
        .select('email, full_name')
        .eq('id', job.client_id)
        .single();
        
      if (clientData && clientData.email) {
        const mailOptions = {
          from: '"Tirgum Sra Marketplace" <billing@geez.et>',
          to: clientData.email,
          subject: `Payment Receipt - Job #${jobId.substring(0,8).toUpperCase()}`,
          html: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #eee; border-radius: 12px; overflow: hidden;">
              <div style="background-color: #895129; padding: 30px; text-align: center;">
                <h1 style="color: white; margin: 0;">Payment Verified</h1>
                <p style="color: #f3f4f6; margin-top: 10px;">Thank you for using Tirgum Sra Marketplace</p>
              </div>
              <div style="padding: 30px;">
                <p>Hello <strong>${clientData.full_name || 'Valued Client'}</strong>,</p>
                <p>We have successfully received and verified your payment.</p>
                <div style="background-color: #f9fafb; padding: 20px; border-radius: 8px; margin: 20px 0;">
                  <p style="margin: 5px 0;"><strong>Job ID:</strong> #${jobId.substring(0,8).toUpperCase()}</p>
                  <p style="margin: 5px 0;"><strong>Reference:</strong> ${transactionRef}</p>
                  <p style="margin: 5px 0;"><strong>Amount Paid:</strong> ${expectedAmount} ETB</p>
                  <p style="margin: 5px 0;"><strong>Status:</strong> <span style="color: #10b981; font-weight: bold;">In Progress</span></p>
                </div>
                <p>Your assigned translator has been notified and will begin working on your document immediately.</p>
              </div>
            </div>
          `
        };
        transporter.sendMail(mailOptions).then(info => {
           console.log("Invoice email sent:", info.messageId);
        }).catch(err => {
           console.error("Failed to send invoice email:", err);
        });
      }
    } catch(err) {
      console.error("Error fetching client email for invoice:", err);
    }

    // Notify the Client
    sendNotification(jobData.client_id, "Payment Verified! ✅", "Your payment was confirmed. The translator has started working on your document.");
    
    // Notify the Translator (if we have their ID)
    if (jobData.translator_id) {
       sendNotification(jobData.translator_id, "New Task Started! 🚀", "A payment has been verified. You can now start the translation.");
    }

  } catch (error) {
    console.error("Verification Error:", error);
    res.status(500).json({ success: false, message: "Internal server error during verification.", error: error.message });
  }
});

// --- SETTLEMENTS & Z-REPORTS (Admin) ---

// Get completed jobs awaiting settlement
app.get('/api/admin/settlements/active', async (req, res) => {
  try {
    // 1. Fetch data from the active_settlement_view
    const { data: summary, error: viewError } = await supabase
      .from('active_settlement_view')
      .select('*');

    if (viewError) throw viewError;

    // 2. Fetch specific completed/unsettled jobs for the audit list
    const { data: jobs, error: jobsError } = await supabase
      .from('jobs')
      .select('*, profiles!fk_jobs_translator(office_name)')
      .eq('status', 'completed')
      .eq('settled', false)
      .order('created_at', { ascending: false });

    if (jobsError) throw jobsError;

    res.json({ summary, jobs });
  } catch (error) {
    console.error("Settlement Fetch Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// Generate Daily Z-Report & Settle Jobs
app.post('/api/admin/settlements/generate-z-report', async (req, res) => {
  try {
    // 1. Fetch all unsettled completed jobs
    const { data: jobs, error: jobsError } = await supabase
      .from('jobs')
      .select('id, price')
      .eq('status', 'completed')
      .eq('settled', false);

    if (jobsError) throw jobsError;
    if (!jobs || jobs.length === 0) {
      return res.status(400).json({ success: false, message: "No unsettled completed jobs found." });
    }

    // 2. Calculate totals
    const totalVolume = jobs.reduce((acc, j) => acc + (Number(j.price) || 0), 0);
    const adminFee = totalVolume * 0.1;
    const netPayout = totalVolume - adminFee;

    // 3. Create Z-Report Entry
    const { data: zReport, error: zError } = await supabase
      .from('z_reports')
      .insert([{
        total_volume: totalVolume,
        admin_fee: adminFee,
        net_payout: netPayout,
        jobs_count: jobs.length
      }])
      .select()
      .single();

    if (zError) throw zError;

    // 4. Mark jobs as settled and link to report
    const jobIds = jobs.map(j => j.id);
    const { error: updateError } = await supabase
      .from('jobs')
      .update({ 
        settled: true, 
        z_report_id: zReport.id 
      })
      .in('id', jobIds);

    if (updateError) throw updateError;

    res.json({ 
      success: true, 
      message: `Z-Report generated for ${jobs.length} jobs!`, 
      zReport 
    });

  } catch (error) {
    console.error("Z-Report Error:", error);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 5000;

// Listen on all network interfaces for Render, Docker, and local development
// When running on Vercel serverless, process.env.VERCEL is automatically set
if (!process.env.VERCEL) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
  });
}

module.exports = app;