import os
import sys
from PIL import Image
from ultralytics import YOLO

WEIGHTS = "best.pt"
OUTPUT_DIR = "D:/Potholes Routing System/output"
CONF_THRESHOLD = 0.25

def detect(image_path: str):
    if not os.path.exists(image_path):
        print(f"Error: image not found at '{image_path}'")
        sys.exit(1)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    model = YOLO(WEIGHTS)

    results = model.predict(source=image_path, conf=CONF_THRESHOLD, save=False)[0]

    pothole_count = len(results.boxes)

    # results.plot() returns a BGR numpy array with boxes/labels drawn by YOLO
    annotated = results.plot()

    output_filename = f"{pothole_count}_potholes_detected.jpg"
    output_path = os.path.join(OUTPUT_DIR, output_filename)

    # Convert BGR → RGB and save with Pillow
    Image.fromarray(annotated[..., ::-1]).save(output_path)

    print(f"Detected {pothole_count} pothole(s)")
    print(f"Result saved to: {output_path}")
    return output_path


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python detect.py <image_path>")
        sys.exit(1)

    detect(sys.argv[1])
