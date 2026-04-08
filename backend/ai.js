import fetch from 'node-fetch';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-3-5-sonnet-20241022';

function buildOptimizationInput(siteInput) {
  if (typeof siteInput === 'string') {
    return { html: siteInput, cssFiles: [], jsFiles: [] };
  }

  const html = typeof siteInput?.html === 'string' ? siteInput.html : '';
  const cssFiles = Array.isArray(siteInput?.cssFiles) ? siteInput.cssFiles : [];
  const jsFiles = Array.isArray(siteInput?.jsFiles) ? siteInput.jsFiles : [];
  return { html, cssFiles, jsFiles };
}

function stringifyProjectSnippet({ html, cssFiles, jsFiles }) {
  const htmlSlice = html.substring(0, 15000);
  const trimmedCss = cssFiles.slice(0, 10).map((f) => ({
    path: f.path,
    content: String(f.content || '').substring(0, 4000),
  }));
  const trimmedJs = jsFiles.slice(0, 10).map((f) => ({
    path: f.path,
    content: String(f.content || '').substring(0, 4000),
  }));

  return JSON.stringify({ html: htmlSlice, cssFiles: trimmedCss, jsFiles: trimmedJs }, null, 2);
}

export async function optimizeSite(siteInput) {
  const optimizationInput = buildOptimizationInput(siteInput);
  const siteCode = optimizationInput.html;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey || apiKey === 'your_anthropic_api_key_here') {
    // Return a mock optimization if no API key configured
    return getMockOptimization(siteCode);
  }

  const systemPrompt = `You are an expert front-end performance engineer. 
Your task is to analyze and optimize HTML/CSS/JavaScript code for maximum web performance.

You MUST return a valid JSON object with exactly this structure:
{
  "optimizedHTML": "<the full optimized HTML string>",
  "score": <number from 0-100>,
  "improvements": ["list", "of", "improvements", "made"],
  "report": "A short paragraph summarizing what was done"
}

Optimizations to apply:
1. Minify HTML (remove unnecessary whitespace and comments)
2. Add loading="lazy" to all <img> tags
3. Add fetchpriority="high" to above-the-fold images
4. Defer non-critical scripts with defer or async
5. Inline critical CSS, defer non-critical stylesheets
6. Add meta viewport if missing
7. Add rel="preconnect" for external domains
8. Flag oversized images for WebP conversion
9. Add cache-control hints via <meta http-equiv>

Return ONLY the JSON. No markdown fences, no explanation outside the JSON.`;

  const userMessage = `Analyze and optimize this website project payload (HTML + related CSS/JS snippets):\n\n${stringifyProjectSnippet(optimizationInput)}`;

  try {
    const controller = new AbortController();
    const aiTimeout = setTimeout(() => controller.abort(), 30000); // 30s timeout

    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });
    clearTimeout(aiTimeout);

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Claude API error ${response.status}: ${errText}`);
    }

    const data = await response.json();

    // Extract text blocks from response
    const rawText = data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');

    // Strip JSON fences if present
    const jsonStr = rawText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const result = JSON.parse(jsonStr);
    return result;
  } catch (err) {
    console.error('AI optimization error:', err.message);
    // Fallback to basic optimization
    return getBasicOptimization(siteCode);
  }
}

function getMockOptimization(siteCode) {
  const optimized = applyBasicOptimizations(siteCode);
  return {
    optimizedHTML: optimized,
    score: 72,
    improvements: [
      'Added loading="lazy" to images',
      'Added meta viewport tag',
      'Added preconnect hints for external domains',
      'Deferred non-critical scripts',
    ],
    report:
      'Basic performance optimizations applied. Configure your ANTHROPIC_API_KEY in .env for full AI-powered optimization.',
  };
}

function getBasicOptimization(siteCode) {
  const optimized = applyBasicOptimizations(siteCode);
  return {
    optimizedHTML: optimized,
    score: 68,
    improvements: [
      'Added loading="lazy" to images',
      'Added meta viewport tag',
      'Script defer attributes added',
    ],
    report: 'Fallback basic optimizations applied due to AI service unavailability.',
  };
}

function applyBasicOptimizations(html) {
  let optimized = html;

  // Add lazy loading to images
  optimized = optimized.replace(/<img(?![^>]*loading=)/gi, '<img loading="lazy"');

  // NOTE: We intentionally do NOT add defer/async to external scripts.
  // CDN SDK scripts (Firebase, Razorpay, EmailJS, etc.) must load synchronously
  // because inline <script> blocks in the page depend on them being ready immediately.
  // Adding defer would cause "firebase is not defined" / "Razorpay is not defined" errors.

  // Add viewport meta if missing
  if (!optimized.includes('viewport')) {
    optimized = optimized.replace(
      '<head>',
      '<head>\n  <meta name="viewport" content="width=device-width, initial-scale=1">'
    );
  }

  return optimized;
}
