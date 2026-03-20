from fastapi import FastAPI, File, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
import os, asyncio, boto3
from botocore.exceptions import BotoCoreError, ClientError

app = FastAPI()

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
async def upload_image(file: UploadFile = File(...)):
    global upload_version, image_counter
    data = await file.read()

    # Save latest locally (for web dashboard /image endpoint)
    with open(LAST_IMAGE_PATH, "wb") as f:
        f.write(data)

    # Respond to phone immediately — S3 upload runs in background
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
<html>
<head>
  <title>Lens — Live</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #080810;
      width: 100vw; height: 100vh;
      display: flex; align-items: center; justify-content: center;
      font-family: -apple-system, sans-serif;
      overflow: hidden;
    }
    #img {
      max-width: 100vw; max-height: 100vh;
      object-fit: contain;
      opacity: 0;
      transition: opacity 0.35s ease;
    }
    #waiting {
      color: #4b5563;
      font-size: 12px;
      letter-spacing: 3px;
      text-transform: uppercase;
    }
    #badge {
      position: fixed;
      top: 20px; right: 20px;
      background: #4ade8018;
      border: 1px solid #4ade8050;
      color: #4ade80;
      padding: 7px 16px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 2px;
      opacity: 0;
      transition: opacity 0.3s ease;
    }
    #pill {
      position: fixed;
      top: 20px; left: 20px;
      background: #ffffff0d;
      border: 1px solid #ffffff15;
      color: #ffffff80;
      padding: 7px 16px;
      border-radius: 20px;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 2.5px;
      display: flex; align-items: center; gap: 8px;
    }
    #dot {
      width: 6px; height: 6px; border-radius: 3px;
      background: #a78bfa;
      animation: pulse 1.8s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.2; }
    }
  </style>
</head>
<body>
  <div id="pill"><span id="dot"></span>LENS</div>
  <div id="waiting">Waiting for image…</div>
  <img id="img" />
  <div id="badge">NEW IMAGE</div>

  <script>
    let isFirst = true;
    let badgeTimer = null;
    const img = document.getElementById('img');
    const waiting = document.getElementById('waiting');
    const badge = document.getElementById('badge');

    const es = new EventSource('/events');

    es.onmessage = async function(e) {
      const version = parseInt(e.data);
      if (version === 0) return;

      if (!isFirst) {
        img.style.opacity = '0';
        await new Promise(r => setTimeout(r, 180));
      }

      img.onload = () => { img.style.opacity = '1'; };
      img.src = '/image?v=' + version;
      waiting.style.display = 'none';

      if (!isFirst) {
        badge.style.opacity = '1';
        clearTimeout(badgeTimer);
        badgeTimer = setTimeout(() => { badge.style.opacity = '0'; }, 2000);
      }
      isFirst = false;
    };

    es.onerror = function() {};
  </script>
</body>
</html>
""")
