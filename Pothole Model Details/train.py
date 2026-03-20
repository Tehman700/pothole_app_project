from ultralytics import YOLO
import os

DATA_YAML = "D:/Potholes Routing System/Pothole.v1-raw.yolov12/data.yaml"
MODEL = "yolo11n.pt"       # pretrained nano model (downloads automatically)
EPOCHS = 50
IMG_SIZE = 640
BATCH = 16
PROJECT = "D:/Potholes Routing System/models"
RUN_NAME = "pothole_detector"

def train():
    model = YOLO(MODEL)

    results = model.train(
        data=DATA_YAML,
        epochs=EPOCHS,
        imgsz=IMG_SIZE,
        batch=BATCH,
        project=PROJECT,
        name=RUN_NAME,
        exist_ok=True,
        patience=20,        # early stopping
        save=True,
        device='cpu',           # GPU; use 'cpu' if no GPU
    )

    best_weights = os.path.join(PROJECT, RUN_NAME, "weights", "best.pt")
    print(f"\nTraining complete. Best weights saved at: {best_weights}")


if __name__ == "__main__":
    train()
