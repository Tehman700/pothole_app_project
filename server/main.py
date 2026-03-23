from fastapi import FastAPI, File, UploadFile, Form
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
import os, asyncio, boto3
from botocore.exceptions import BotoCoreError, ClientError

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "uploads"
LAST_IMAGE_PATH = os.path.join(UPLOAD_DIR, "last.jpg")
S3_BUCKET = "myapp-images-gallery"   # Your S3 bucket name

upload_version = 0
clients: set[asyncio.Queue] = set()

os.makedirs(UPLOAD_DIR, exist_ok=True)

# boto3 picks up credentials automatically from the EC2 IAM Role — no keys needed here
s3 = boto3.client("s3")

# Start image counter from however many .jpg objects already exist in S3
def get_s3_image_count():
    try:
        paginator = s3.get_paginator("list_objects_v2")
        count = 0
        for page in paginator.paginate(Bucket=S3_BUCKET):
            for obj in page.get("Contents", []):
                if obj["Key"].endswith(".jpg"):
                    count += 1
        return count
    except Exception:
        return 0

image_counter = get_s3_image_count()


def upload_to_s3(data: bytes, s3_key: str):
    """Runs in a thread — does not block the response."""
    try:
        s3.put_object(Bucket=S3_BUCKET, Key=s3_key, Body=data, ContentType="image/jpeg")
    except Exception as e:
        print(f"[s3] Upload failed for {s3_key}: {e}")


@app.post("/upload")
async def upload_image(file: UploadFile = File(...), filename: str = Form(None)):
    global upload_version, image_counter
    data = await file.read()

    # Save latest locally (for web dashboard /image endpoint)
    with open(LAST_IMAGE_PATH, "wb") as f:
        f.write(data)

    # Use app-provided filename (e.g. "john_482913") or fall back to counter
    if filename:
        s3_key = f"{filename}.jpg"
    else:
        image_counter += 1
        s3_key = f"{image_counter}.jpg"

    asyncio.get_event_loop().run_in_executor(None, upload_to_s3, data, s3_key)

    upload_version += 1
    for q in list(clients):
        await q.put(upload_version)

    return {"status": "ok", "version": upload_version, "saved_as": s3_key}


@app.get("/events")
async def events():
    queue: asyncio.Queue = asyncio.Queue()
    clients.add(queue)

    async def stream():
        yield f"data: {upload_version}\n\n"
        try:
            while True:
                version = await queue.get()
                yield f"data: {version}\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            clients.discard(queue)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/image")
async def get_image():
    if not os.path.exists(LAST_IMAGE_PATH):
        return HTMLResponse("No image yet", status_code=404)
    return FileResponse(LAST_IMAGE_PATH, media_type="image/jpeg")


@app.get("/")
async def root():
    return HTMLResponse("""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Server Created by Tehman Hassan</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700;800&display=swap');

    *, *::before, *::after { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --purple: #a78bfa;
      --blue:   #60a5fa;
      --green:  #4ade80;
      --bg:     #05050f;
    }

    body {
      font-family: 'Inter', sans-serif;
      background: var(--bg);
      color: #fff;
      min-height: 100vh;
      overflow-x: hidden;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }

    /* ── Animated gradient background ── */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse 80% 60% at 20% 20%, #a78bfa18 0%, transparent 60%),
        radial-gradient(ellipse 60% 80% at 80% 80%, #60a5fa12 0%, transparent 60%),
        radial-gradient(ellipse 50% 50% at 50% 50%, #4ade8008 0%, transparent 70%);
      animation: bgPulse 8s ease-in-out infinite alternate;
      pointer-events: none;
      z-index: 0;
    }

    @keyframes bgPulse {
      0%   { opacity: 0.6; transform: scale(1); }
      100% { opacity: 1;   transform: scale(1.05); }
    }

    /* ── Floating particles ── */
    .particles { position: fixed; inset: 0; pointer-events: none; z-index: 0; overflow: hidden; }
    .particle {
      position: absolute;
      width: 2px; height: 2px;
      border-radius: 50%;
      background: var(--purple);
      opacity: 0;
      animation: float linear infinite;
    }
    @keyframes float {
      0%   { transform: translateY(100vh) translateX(0);   opacity: 0; }
      10%  { opacity: 0.6; }
      90%  { opacity: 0.3; }
      100% { transform: translateY(-10vh) translateX(60px); opacity: 0; }
    }

    /* ── Main card ── */
    .card {
      position: relative;
      z-index: 1;
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 28px;
      padding: 52px 56px;
      max-width: 680px;
      width: 90%;
      backdrop-filter: blur(20px);
      animation: cardIn 0.9s cubic-bezier(0.16,1,0.3,1) both;
      box-shadow: 0 0 80px rgba(167,139,250,0.07);
    }

    @media (max-width: 480px) {
      .card {
        padding: 36px 28px;
        border-radius: 20px;
        width: 94%;
      }
      .name { font-size: 32px; }
      .uni-badge { font-size: 11px; padding: 5px 12px; }
      .status-text { font-size: 12px; }
      .footer { font-size: 10px; text-align: center; padding: 0 16px; }
    }

    @keyframes cardIn {
      from { opacity: 0; transform: translateY(40px) scale(0.96); }
      to   { opacity: 1; transform: translateY(0)    scale(1); }
    }

    /* ── University badge ── */
    .uni-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: rgba(167,139,250,0.1);
      border: 1px solid rgba(167,139,250,0.25);
      border-radius: 999px;
      padding: 6px 16px;
      font-size: 12px;
      font-weight: 600;
      color: var(--purple);
      letter-spacing: 0.5px;
      margin-bottom: 28px;
      animation: fadeUp 0.6s 0.2s both;
    }

    .uni-dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: var(--purple);
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%       { opacity: 0.4; transform: scale(0.7); }
    }

    /* ── Name ── */
    .name {
      font-size: clamp(32px, 5vw, 48px);
      font-weight: 800;
      line-height: 1.1;
      background: linear-gradient(135deg, #fff 30%, var(--purple) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 6px;
      animation: fadeUp 0.6s 0.3s both;
    }

    .roll {
      font-size: 14px;
      color: rgba(255,255,255,0.35);
      font-weight: 400;
      margin-bottom: 28px;
      letter-spacing: 1px;
      animation: fadeUp 0.6s 0.4s both;
    }

    /* ── Divider ── */
    .divider {
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.08), transparent);
      margin: 24px 0;
      animation: fadeUp 0.6s 0.5s both;
    }

    /* ── Project title ── */
    .project-label {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 2.5px;
      text-transform: uppercase;
      color: rgba(255,255,255,0.25);
      margin-bottom: 8px;
      animation: fadeUp 0.6s 0.55s both;
    }

    .project-title {
      font-size: 22px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 16px;
      animation: fadeUp 0.6s 0.6s both;
    }

    .project-title span {
      background: linear-gradient(90deg, var(--blue), var(--purple));
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    /* ── Description ── */
    .desc {
      font-size: 14px;
      line-height: 1.8;
      color: rgba(255,255,255,0.45);
      margin-bottom: 32px;
      animation: fadeUp 0.6s 0.65s both;
    }

    /* ── Tech stack ── */
    .stack {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 36px;
      animation: fadeUp 0.6s 0.7s both;
    }

    .tag {
      padding: 5px 14px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid;
    }

    .tag.purple { background: rgba(167,139,250,0.1); border-color: rgba(167,139,250,0.3); color: var(--purple); }
    .tag.blue   { background: rgba(96,165,250,0.1);  border-color: rgba(96,165,250,0.3);  color: var(--blue); }
    .tag.green  { background: rgba(74,222,128,0.1);  border-color: rgba(74,222,128,0.3);  color: var(--green); }

    /* ── Status row ── */
    .status-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 18px;
      background: rgba(74,222,128,0.06);
      border: 1px solid rgba(74,222,128,0.15);
      border-radius: 14px;
      animation: fadeUp 0.6s 0.75s both;
    }

    .status-dot {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: var(--green);
      box-shadow: 0 0 8px var(--green);
      animation: pulse 2s ease-in-out infinite;
      flex-shrink: 0;
    }

    .status-text { font-size: 13px; color: rgba(255,255,255,0.5); }
    .status-text strong { color: var(--green); font-weight: 600; }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(18px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    /* ── Footer ── */
    .footer {
      position: relative;
      z-index: 1;
      margin-top: 28px;
      font-size: 11px;
      color: rgba(255,255,255,0.15);
      letter-spacing: 0.5px;
      animation: fadeUp 0.6s 0.9s both;
    }
  </style>
</head>
<body>

  <!-- Particles -->
  <div class="particles" id="particles"></div>

  <!-- Card -->
  <div class="card">
    <div class="uni-badge">
      <span class="uni-dot"></span>
      University of Engineering and Technology Taxila - Computer Engineering
    </div>

    <div class="name">Tehman Hassan</div>

    <div class="divider"></div>

    <div class="status-row">
      <div class="status-dot"></div>
      <div class="status-text">This server is currently under <strong>extreme violent testing</strong> for Tehman's project</div>
    </div>
  </div>

  <div class="footer">© 2026 Tehman Hassan · University of Engineering and Technology Taxila</div>

  <script>
    // Generate floating particles
    const container = document.getElementById('particles');
    const colors = ['#a78bfa', '#60a5fa', '#4ade80'];
    for (let i = 0; i < 35; i++) {
      const p = document.createElement('div');
      p.className = 'particle';
      p.style.left     = Math.random() * 100 + 'vw';
      p.style.width    = (Math.random() * 2 + 1) + 'px';
      p.style.height   = p.style.width;
      p.style.background = colors[Math.floor(Math.random() * colors.length)];
      p.style.animationDuration  = (Math.random() * 12 + 8) + 's';
      p.style.animationDelay     = (Math.random() * 10) + 's';
      container.appendChild(p);
    }
  </script>
</body>
</html>
""")
