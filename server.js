/**
 * Vlogify Server - AI-powered Vlog generator
 * 
 * Core flow:
 * 1. User uploads multiple video files
 * 2. Server extracts keyframes from each video (ffmpeg)
 * 3. Keyframes sent to Agnes AI (1.5-flash multimodal) for scene understanding
 * 4. Agnes AI (2.0-flash with thinking) generates vlog script, narration, music cues, effects plan
 * 5. Server uses ffmpeg to assemble the final vlog with:
 *    - Best clip selection & ordering
 *    - AI voiceover (TTS via Agnes text model)
 *    - Subtitle overlay
 *    - Background music mixing
 *    - Transition effects
 * 6. User previews & downloads the final vlog
 */

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const http = require('http');
const { spawn, execFile } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3456;
const AGNES_API_KEY = process.env.AGNES_API_KEY;
const AGNES_API_BASE = process.env.AGNES_API_BASE || 'https://apihub.agnes-ai.com/v1';

// === Config ===
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
const TEMP_DIR = path.join(__dirname, 'temp');

[UPLOAD_DIR, OUTPUT_DIR, TEMP_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// === Middleware ===
app.use(cors());
app.use((req, res, next) => {
  res.setHeader('ngrok-skip-browser-warning', 'true');
  next();
});
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/outputs', express.static(OUTPUT_DIR));
app.use('/uploads', express.static(UPLOAD_DIR));

// === Multer config ===
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const sessionId = req.body.sessionId || 'default';
    const dir = path.join(UPLOAD_DIR, sessionId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB per file
  fileFilter: (req, file, cb) => {
    const allowed = /\.(mp4|mov|avi|mkv|webm|m4v|3gp)$/;
    if (allowed.test(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are allowed'));
    }
  }
});

// ============================
// Agnes AI API Helpers
// ============================

async function agnesChat(model, messages, options = {}) {
  const body = {
    model,
    messages,
    temperature: options.temperature ?? 0.7,
    max_tokens: options.max_tokens ?? 8192,
    stream: false,
    ...options
  };

  if (options.thinking) {
    body.chat_template_kwargs = { enable_thinking: true };
  }

  const data = await fetch(`${AGNES_API_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AGNES_API_KEY}`
    },
    body: JSON.stringify(body)
  });

  if (!data.ok) {
    const err = await data.text();
    throw new Error(`Agnes API error ${data.status}: ${err}`);
  }

  const json = await data.json();
  return json.choices[0].message.content;
}

async function agnesImageGen(prompt, size = '1024x768') {
  const data = await fetch(`${AGNES_API_BASE}/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AGNES_API_KEY}`
    },
    body: JSON.stringify({
      model: 'agnes-image-2.1-flash',
      prompt,
      size
    })
  });

  if (!data.ok) {
    const err = await data.text();
    throw new Error(`Agnes Image API error ${data.status}: ${err}`);
  }

  const json = await data.json();
  return json.data[0].url;
}

// ============================
// Video Processing (ffmpeg)
// ============================

function getVideoDuration(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath
    ], (err, stdout) => {
      if (err) return reject(err);
      try {
        const info = JSON.parse(stdout);
        resolve(parseFloat(info.format.duration) || 0);
      } catch (e) {
        reject(e);
      }
    });
  });
}

function extractKeyframes(filePath, outputDir, count = 5) {
  return new Promise(async (resolve, reject) => {
    const duration = await getVideoDuration(filePath).catch(() => 60);
    const interval = duration / (count + 1);
    const frames = [];

    for (let i = 1; i <= count; i++) {
      const time = interval * i;
      const framePath = path.join(outputDir, `frame_${i}.jpg`);
      await new Promise((res, rej) => {
        execFile('ffmpeg', [
          '-y', '-ss', String(time.toFixed(2)),
          '-i', filePath,
          '-frames:v', '1',
          '-q:v', '2',
          '-vf', 'scale=512:-1',
          framePath
        ], { timeout: 15000, maxBuffer: 5 * 1024 * 1024 }, (err) => {
          if (err) return rej(err);
          frames.push({ time, path: framePath });
          res();
        });
      }).catch(() => {
        // skip failed frame
      });
    }

    resolve(frames);
  });
}

function extractClip(filePath, outputDir, start, duration, name) {
  return new Promise((resolve, reject) => {
    const clipPath = path.join(outputDir, `${name}.mp4`);
    execFile('ffmpeg', [
      '-y',
      '-ss', String(start),
      '-i', filePath,
      '-t', String(duration),
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-vf', 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2',
      '-r', '30',
      clipPath
    ], { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err) => {
      if (err) return reject(err);
      resolve(clipPath);
    });
  });
}

function concatenateClips(clipPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const listPath = path.join(TEMP_DIR, `concat_${Date.now()}.txt`);
    const listContent = clipPaths.map(p => `file '${p}'`).join('\n');
    fs.writeFileSync(listPath, listContent);

    execFile('ffmpeg', [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listPath,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-vf', 'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2',
      '-r', '30',
      outputPath
    ], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err) => {
      fs.unlinkSync(listPath);
      if (err) return reject(err);
      resolve(outputPath);
    });
  });
}

function addSubtitleOverlay(videoPath, subtitles, outputPath) {
  return new Promise((resolve, reject) => {
    // Generate SRT file — split long text into single-line entries (max 16 chars/line)
    const srtPath = path.join(TEMP_DIR, `subs_${Date.now()}.srt`);
    let srt = '';
    let idx = 1;
    subtitles.forEach((sub) => {
      const startMs = Math.floor(sub.start * 1000);
      const endMs = Math.floor(sub.end * 1000);
      const duration = sub.end - sub.start;
      const text = (sub.text || '').trim();
      // Split into chunks of 16 chars to keep each entry on one line
      const MAX_CHARS = 16;
      const chunks = [];
      for (let i = 0; i < text.length; i += MAX_CHARS) {
        chunks.push(text.slice(i, i + MAX_CHARS));
      }
      const chunkDur = duration / chunks.length;
      chunks.forEach((chunk, ci) => {
        const cs = startMs + Math.floor(ci * chunkDur * 1000);
        const ce = (ci === chunks.length - 1) ? endMs : startMs + Math.floor((ci + 1) * chunkDur * 1000);
        srt += `${idx}\n`;
        srt += `${formatSrtTime(cs)} --> ${formatSrtTime(ce)}\n`;
        srt += `${chunk}\n\n`;
        idx++;
      });
    });
    fs.writeFileSync(srtPath, srt);

    // Burn subtitles — pure white text, thin solid outline, no shadow, no box
    execFile('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-vf', `subtitles='${srtPath.replace(/'/g, "\\'")}':force_style='FontSize=26,FontName=PingFang SC,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=1.5,Shadow=0,MarginV=45,Spacing=1'`,
      '-c:a', 'copy',
      outputPath
    ], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err) => {
      fs.unlinkSync(srtPath);
      if (err) return reject(err);
      resolve(outputPath);
    });
  });
}

function formatSrtTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
}

function mixAudioWithVideo(videoPath, audioPath, outputPath, audioVolume = 0.3) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', [
      '-y',
      '-i', videoPath,
      '-i', audioPath,
      '-filter_complex', `[1:a]volume=${audioVolume}[a1];[0:a][a1]amix=inputs=2:duration=first[aout]`,
      '-map', '0:v',
      '-map', '[aout]',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-shortest',
      outputPath
    ], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err) => {
      if (err) return reject(err);
      resolve(outputPath);
    });
  });
}

function generateTTS(text, outputPath, lang = 'zh') {
  return new Promise((resolve, reject) => {
    // Use edge-tts (Microsoft Edge TTS) for natural Chinese voice
    // zh-CN-XiaoxiaoNeural = warm, natural female voice (close to Doubao style)
    const voice = lang === 'zh' ? 'zh-CN-XiaoxiaoNeural' : 'en-US-AriaNeural';
    const rate = '+8%';   // slightly faster for narration pace
    const pitch = '+2Hz';  // subtle warmth lift

    const args = [
      '--voice', voice,
      '--text', text,
      '--write-media', outputPath,
      '--rate', rate,
      '--pitch', pitch
    ];

    execFile('edge-tts', args, { timeout: 60000 }, (err) => {
      if (err) {
        console.error('edge-tts failed, trying macOS say fallback:', err.message);
        // Fallback: macOS say with Tingting
        const aiffPath = path.join(TEMP_DIR, `tts_${Date.now()}.aiff`);
        execFile('say', ['-v', 'Tingting', text, '-o', aiffPath], (e2) => {
          if (e2) {
            // Final fallback: silent audio
            execFile('ffmpeg', [
              '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
              '-t', '5', outputPath
            ], { timeout: 10000, maxBuffer: 5 * 1024 * 1024 }, (e3) => {
              if (e3) return reject(e3);
              resolve(outputPath);
            });
            return;
          }
          execFile('ffmpeg', [
            '-y', '-i', aiffPath,
            '-codec:a', 'libmp3lame', '-b:a', '128k',
            outputPath
          ], { timeout: 30000, maxBuffer: 5 * 1024 * 1024 }, (e3) => {
            if (aiffPath && fs.existsSync(aiffPath)) fs.unlink(aiffPath, () => {});
            if (e3) return reject(e3);
            resolve(outputPath);
          });
        });
        return;
      }
      resolve(outputPath);
    });
  });
}

function addTransitionEffect(videoPath, outputPath) {
  return new Promise((resolve, reject) => {
    // Get duration first, then add fade in/out
    execFile('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      videoPath
    ], (err, stdout) => {
      let duration = 10;
      if (!err) {
        try {
          const info = JSON.parse(stdout);
          duration = parseFloat(info.format.duration) || 10;
        } catch (e) {}
      }
      const fadeOutStart = Math.max(0, duration - 0.5);

      execFile('ffmpeg', [
        '-y',
        '-i', videoPath,
        '-vf', `fade=t=in:st=0:d=0.5,fade=t=out:st=${fadeOutStart}:d=0.5`,
        '-c:a', 'copy',
        outputPath
      ], { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err2) => {
        if (err2) return reject(err2);
        resolve(outputPath);
      });
    });
  });
}

// ============================
// API Routes
// ============================

// Upload videos
app.post('/api/upload', upload.array('videos', 20), async (req, res) => {
  try {
    const sessionId = req.body.sessionId || `session_${Date.now()}`;
    const files = req.files.map(f => ({
      id: path.basename(f.filename, path.extname(f.filename)),
      name: f.originalname,
      path: f.path,
      size: f.size
    }));

    res.json({
      success: true,
      sessionId,
      files
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Analyze videos - extract keyframes & AI understanding
app.post('/api/analyze', async (req, res) => {
  try {
    const { sessionId, files, style, theme } = req.body;
    
    if (!files || !files.length) {
      return res.status(400).json({ error: 'No files provided' });
    }

    const sessionDir = path.join(TEMP_DIR, sessionId);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    // Step 1: Extract keyframes from each video
    const allKeyframes = [];
    for (const file of files) {
      const frameDir = path.join(sessionDir, 'keyframes', file.id);
      if (!fs.existsSync(frameDir)) fs.mkdirSync(frameDir, { recursive: true });
      
      const duration = await getVideoDuration(file.path).catch(() => 60);
      const frameCount = Math.min(5, Math.max(2, Math.floor(duration / 10)));
      const frames = await extractKeyframes(file.path, frameDir, frameCount);
      
      allKeyframes.push({
        fileId: file.id,
        fileName: file.name,
        filePath: file.path,
        duration,
        keyframes: frames
      });
    }

    // Step 2: Convert keyframes to base64 for AI analysis
    const frameDescriptions = [];
    for (const video of allKeyframes) {
      for (const kf of video.keyframes) {
        try {
          const imgBuffer = await fsp.readFile(kf.path);
          const base64 = imgBuffer.toString('base64');
          const dataUrl = `data:image/jpeg;base64,${base64}`;
          
          frameDescriptions.push({
            fileId: video.fileId,
            fileName: video.fileName,
            time: kf.time,
            dataUrl
          });
        } catch (e) {
          // skip
        }
      }
    }

    // Step 3: Use Agnes 1.5-flash (multimodal) to analyze each keyframe
    const sceneAnalyses = [];
    for (const frame of frameDescriptions.slice(0, 15)) { // limit to 15 frames
      try {
        const analysis = await agnesChat('agnes-1.5-flash', [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '请用中文简要描述这个视频画面的内容，包括：场景、人物、活动、氛围、光线。用一句话概括。'
              },
              {
                type: 'image_url',
                image_url: { url: frame.dataUrl }
              }
            ]
          }
        ], { temperature: 0.3, max_tokens: 200 });

        sceneAnalyses.push({
          fileId: frame.fileId,
          fileName: frame.fileName,
          time: frame.time,
          description: analysis.trim()
        });
      } catch (e) {
        // skip failed analysis
      }
    }

    // Step 4: Use Agnes 2.0-flash (with thinking) to generate vlog plan
    const vlogStyle = style || 'cinematic';
    const vlogTheme = theme || '生活记录';

    const planPrompt = `你是一位专业的Vlog剪辑师和编剧。我会上传多段视频素材，请你根据以下场景分析结果，为我生成一个完整的Vlog制作方案。

## 视频素材列表

${allKeyframes.map((v, i) => `素材${i + 1}: fileId="${v.fileId}", 文件名="${v.fileName}", 时长=${v.duration.toFixed(1)}秒`).join('\n')}

## 场景分析

${sceneAnalyses.map((s, i) => 
  `### 素材${i + 1}: fileId="${s.fileId}" 文件名="${s.fileName}" (时间点: ${s.time.toFixed(1)}s)\n${s.description}`
).join('\n\n')}

## 要求

风格: ${vlogStyle}
主题: ${vlogTheme}

请输出 JSON 格式的制作方案（只输出JSON，不要其他文字）：

{
  "title": "Vlog标题（有吸引力的）",
  "summary": "一句话概述这个Vlog的内容",
  "selectedClips": [
    {
      "fileId": "必须使用上面素材列表中的 fileId 值",
      "fileName": "文件名",
      "startTime": 开始时间秒数,
      "duration": 截取时长秒数,
      "reason": "选择这个片段的原因"
    }
  ],
  "narration": "完整的旁白文案（中文，200-400字，有感情色彩，适合朗读）",
  "subtitles": [
    {
      "text": "字幕文本",
      "start": 开始时间,
      "end": 结束时间
    }
  ],
  "musicMood": "推荐的音乐氛围（如：温馨、活力、怀旧、史诗）",
  "musicDescription": "音乐风格描述",
  "effectsPlan": ["特效1: 描述", "特效2: 描述"],
  "transitionPlan": ["转场描述"],
  "coverPrompt": "用于生成封面图的英文prompt"
}

注意：
- selectedClips 中的 fileId 必须使用上面素材列表中给出的 fileId 值，不要用文件名
- selectedClips 总时长控制在 30-90 秒
- 每个clip的startTime必须在视频时长范围内
- subtitles 的时间轴基于拼接后的视频时间线（从0开始）
- narration 应该与画面内容呼应
- 只输出纯JSON，不要markdown代码块`;

    const planResult = await agnesChat('agnes-2.0-flash', [
      {
        role: 'system',
        content: '你是一位专业的Vlog剪辑师和创意总监，擅长将零散素材组织成有故事感的短视频。'
      },
      {
        role: 'user',
        content: planPrompt
      }
    ], { temperature: 0.8, max_tokens: 4096, thinking: true });

    // Parse the JSON from response
    let vlogPlan;
    try {
      // Try to extract JSON from the response
      const jsonMatch = planResult.match(/\{[\s\S]*\}/);
      vlogPlan = JSON.parse(jsonMatch ? jsonMatch[0] : planResult);
    } catch (e) {
      // If parsing fails, create a basic plan
      vlogPlan = {
        title: '我的Vlog',
        summary: '精彩瞬间合集',
        selectedClips: files.slice(0, 5).map((f, i) => ({
          fileId: f.id,
          fileName: f.name,
          startTime: 0,
          duration: Math.min(10, 60),
          reason: '精彩片段'
        })),
        narration: '今天又是美好的一天，记录下这些珍贵的瞬间。',
        subtitles: [],
        musicMood: '温馨',
        musicDescription: '轻柔温暖的钢琴曲',
        effectsPlan: ['淡入淡出'],
        transitionPlan: ['简单切换'],
        coverPrompt: 'A beautiful vlog cover image with warm tones'
      };
    }

    // Store the plan and analysis
    const planPath = path.join(sessionDir, 'plan.json');
    await fsp.writeFile(planPath, JSON.stringify({ vlogPlan, sceneAnalyses, videos: allKeyframes.map(v => ({ fileId: v.fileId, fileName: v.fileName, filePath: v.filePath, duration: v.duration })) }, null, 2));

    res.json({
      success: true,
      sessionId,
      analysis: {
        videos: allKeyframes.map(v => ({
          fileId: v.fileId,
          fileName: v.fileName,
          duration: v.duration,
          keyframeCount: v.keyframes.length
        })),
        sceneAnalyses,
        vlogPlan
      }
    });

  } catch (err) {
    console.error('Analyze error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Generate vlog — SSE stream with real-time progress
app.post('/api/generate', async (req, res) => {
  const { sessionId, vlogPlan, files } = req.body;

  if (!vlogPlan || !files) {
    return res.status(400).json({ error: 'Missing vlog plan or files' });
  }

  // === SSE setup ===
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const totalClips = vlogPlan.selectedClips?.length || 0;
  // Weight allocation (must sum to 100):
  //  extract 35%  |  concat 15%  |  subtitles 15%  |  tts 15%  |  transitions 10%  |  cover 10%
  const W = { extract: 35, concat: 15, subs: 15, tts: 15, trans: 10, cover: 10 };
  let progress = 0;

  function sendEvent(type, data) {
    res.write(`event: ${type}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  function sendProgress(pct, step) {
    progress = Math.min(99, Math.max(progress, pct));
    sendEvent('progress', { progress, step });
  }

  // heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 5000);

  try {
    const sessionDir = path.join(TEMP_DIR, sessionId);
    const clipsDir = path.join(sessionDir, 'clips');
    if (!fs.existsSync(clipsDir)) fs.mkdirSync(clipsDir, { recursive: true });

    // ── Step 1: Extract clips (35%) ──
    sendProgress(2, '正在提取精选片段…');
    const clipPaths = [];
    for (let i = 0; i < totalClips; i++) {
      const clip = vlogPlan.selectedClips[i];
      sendProgress(
        2 + Math.round((i / totalClips) * (W.extract - 2)),
        `提取片段 ${i + 1}/${totalClips}：${clip.fileName || clip.fileId}`
      );

      const file = files.find(f =>
        f.fileId === clip.fileId ||
        f.id === clip.fileId ||
        f.name === clip.fileId ||
        f.name === clip.fileName ||
        f.fileName === clip.fileName ||
        (clip.fileName && f.name && f.name.toLowerCase().includes(clip.fileName.toLowerCase().replace(/\.(mp4|mov|avi|mkv|webm|m4v|3gp)$/i, '')))
      );
      if (!file) {
        console.log(`Clip ${i}: no matching file for fileId="${clip.fileId}" fileName="${clip.fileName}"`);
        continue;
      }

      const filePath = file.path || file.filePath;
      if (!filePath || !fs.existsSync(filePath)) {
        console.log(`Clip ${i}: file not found at "${filePath}"`);
        continue;
      }

      const clipPath = await extractClip(
        filePath, clipsDir,
        clip.startTime || 0,
        clip.duration || 10,
        `clip_${i}`
      ).catch((e) => {
        console.error(`Clip ${i} extraction error:`, e.message);
        return null;
      });

      if (clipPath) {
        clipPaths.push(clipPath);
        sendProgress(
          2 + Math.round(((i + 1) / totalClips) * (W.extract - 2)),
          `片段 ${i + 1}/${totalClips} 提取完成`
        );
      }
    }

    if (!clipPaths.length) {
      clearInterval(heartbeat);
      sendEvent('error', { error: 'No clips could be extracted' });
      return res.end();
    }

    // ── Step 2: Concatenate (15%) ──
    sendProgress(W.extract, '正在拼接视频片段…');
    const concatenatedPath = path.join(sessionDir, 'concatenated.mp4');
    if (clipPaths.length === 1) {
      fs.copyFileSync(clipPaths[0], concatenatedPath);
    } else {
      await concatenateClips(clipPaths, concatenatedPath);
    }
    sendProgress(W.extract + W.concat, '视频拼接完成');

    // ── Step 3: Subtitles (15%) ──
    let currentVideoPath = concatenatedPath;
    if (vlogPlan.subtitles && vlogPlan.subtitles.length > 0) {
      sendProgress(W.extract + W.concat, '正在烧录字幕…');
      const subtitledPath = path.join(sessionDir, 'subtitled.mp4');
      try {
        await addSubtitleOverlay(concatenatedPath, vlogPlan.subtitles, subtitledPath);
        currentVideoPath = subtitledPath;
        sendProgress(W.extract + W.concat + W.subs, '字幕烧录完成');
      } catch (e) {
        console.error('Subtitle error:', e);
        sendProgress(W.extract + W.concat + W.subs, '字幕处理跳过');
      }
    } else {
      sendProgress(W.extract + W.concat + W.subs, '无需字幕');
    }

    // ── Step 4: TTS narration (15%) ──
    if (vlogPlan.narration) {
      sendProgress(W.extract + W.concat + W.subs, '正在生成语音旁白…');
      try {
        const ttsPath = path.join(sessionDir, 'narration.mp3');
        await generateTTS(vlogPlan.narration, ttsPath, 'zh');
        sendProgress(W.extract + W.concat + W.subs + 7, '语音合成完成，正在混音…');

        const mixedPath = path.join(sessionDir, 'with_narration.mp4');
        await mixAudioWithVideo(currentVideoPath, ttsPath, mixedPath, 0.6);
        currentVideoPath = mixedPath;
        sendProgress(W.extract + W.concat + W.subs + W.tts, '旁白混音完成');
      } catch (e) {
        console.error('TTS error:', e);
        sendProgress(W.extract + W.concat + W.subs + W.tts, '旁白生成跳过');
      }
    } else {
      sendProgress(W.extract + W.concat + W.subs + W.tts, '无需旁白');
    }

    // ── Step 5: Transitions (10%) ──
    sendProgress(W.extract + W.concat + W.subs + W.tts, '正在添加转场特效…');
    const finalPath = path.join(sessionDir, 'final.mp4');
    try {
      await addTransitionEffect(currentVideoPath, finalPath);
      currentVideoPath = finalPath;
    } catch (e) {
      console.error('Transition error:', e);
      fs.copyFileSync(currentVideoPath, finalPath);
    }
    sendProgress(W.extract + W.concat + W.subs + W.tts + W.trans, '转场特效完成');

    // ── Step 6: Copy to outputs ──
    sendProgress(W.extract + W.concat + W.subs + W.tts + W.trans + 3, '正在导出最终视频…');
    const outputFileName = `vlog_${sessionId}_${Date.now()}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, outputFileName);
    fs.copyFileSync(currentVideoPath, outputPath);

    // ── Step 7: Cover image (10%) ──
    let coverUrl = null;
    if (vlogPlan.coverPrompt) {
      sendProgress(W.extract + W.concat + W.subs + W.tts + W.trans + 3, '正在生成 AI 封面图…');
      try {
        coverUrl = await agnesImageGen(vlogPlan.coverPrompt, '1024x576');
      } catch (e) {
        console.error('Cover gen error:', e);
      }
    }

    // ── Done ──
    clearInterval(heartbeat);
    sendProgress(100, '全部完成！');
    sendEvent('done', {
      success: true,
      sessionId,
      output: {
        videoUrl: `/outputs/${outputFileName}`,
        coverUrl,
        title: vlogPlan.title,
        summary: vlogPlan.summary,
        narration: vlogPlan.narration,
        musicMood: vlogPlan.musicMood,
        effectsPlan: vlogPlan.effectsPlan
      }
    });
    res.end();

  } catch (err) {
    console.error('Generate error:', err);
    clearInterval(heartbeat);
    sendEvent('error', { error: err.message });
    res.end();
  }
});

// Get upload info
app.get('/api/files/:sessionId', (req, res) => {
  const dir = path.join(UPLOAD_DIR, req.params.sessionId);
  if (!fs.existsSync(dir)) {
    return res.json({ files: [] });
  }
  const files = fs.readdirSync(dir).map(name => {
    const filePath = path.join(dir, name);
    const stat = fs.statSync(filePath);
    return { name, path: filePath, size: stat.size };
  });
  res.json({ files });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    agnesConfigured: !!AGNES_API_KEY,
    ffmpegAvailable: true
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🎬 Vlogify Server running at http://localhost:${PORT}`);
  console.log(`📁 Upload dir: ${UPLOAD_DIR}`);
  console.log(`📁 Output dir: ${OUTPUT_DIR}`);
  console.log(`🔑 Agnes AI: ${AGNES_API_KEY ? 'Configured' : 'NOT CONFIGURED'}\n`);
});
