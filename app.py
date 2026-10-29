```python
import os
import io
import sys
import socket
import secrets
import threading
import webbrowser
from pathlib import Path
from datetime import datetime

import qrcode
from flask import (
    Flask,
    render_template,
    request,
    jsonify,
    send_file,
    session,
    redirect,
    url_for,
    abort,
)

APP_NAME = "QR Print"
PORT = 8081

BASE_DIR = Path(
    getattr(sys, "_MEIPASS", Path(__file__).resolve().parent)
)

if getattr(sys, "frozen", False):
    DATA_DIR = Path.home() / "QR Print"
else:
    DATA_DIR = Path(__file__).resolve().parent / "data"

UPLOAD_DIR = DATA_DIR / "uploads"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

ALLOWED_EXTENSIONS = {
    ".pdf",
    ".jpg",
    ".jpeg",
    ".png",
    ".bmp",
}

MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MB per file

app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
)

app.secret_key = secrets.token_hex(32)
app.config["MAX_CONTENT_LENGTH"] = MAX_FILE_SIZE
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"

# A new PIN is generated when the program starts.
ACCESS_PIN = f"{secrets.randbelow(10000):04d}"

# Uploaded-file information is kept while the program is running.
FILES = {}
FILES_LOCK = threading.Lock()


def get_local_ip():
    """Find the PC's local network IPv4 address."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    try:
        sock.connect(("192.0.0.1", 80))
        ip_address = sock.getsockname()[0]

        if ip_address.startswith("127."):
            raise OSError("Loopback address")

        return ip_address

    except OSError:
        try:
            hostname = socket.gethostname()
            addresses = socket.getaddrinfo(
                hostname,
                None,
                socket.AF_INET,
            )

            for item in addresses:
                address = item[4][0]

                if not address.startswith("127."):
                    return address

        except OSError:
            pass

        return "127.0.0.1"

    finally:
        sock.close()


def get_phone_url():
    """Build the phone address using the fixed port."""
    return f"http://{get_local_ip()}:{PORT}/"


def make_qr_image():
    """Generate a QR code for the phone webpage."""
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=4,
    )

    qr.add_data(get_phone_url())
    qr.make(fit=True)

    image = qr.make_image(
        fill_color="black",
        back_color="white",
    )

    output = io.BytesIO()
    image.save(output, format="PNG")
    output.seek(0)

    return output


def is_allowed_file(filename):
    return Path(filename).suffix.lower() in ALLOWED_EXTENSIONS


def safe_filename(filename):
    """Remove unsafe path components from an uploaded filename."""
    filename = filename.replace("\\", "/").split("/")[-1]
    filename = filename.strip()

    if not filename or filename in {".", ".."}:
        return "uploaded_file"

    return filename[:180]


def require_pin():
    return session.get("authenticated") is True


@app.get("/")
def index():
    return render_template(
        "index.html",
        app_name=APP_NAME,
        port=PORT,
    )


@app.get("/qr.png")
def qr_image():
    return send_file(
        make_qr_image(),
        mimetype="image/png",
        max_age=0,
    )


@app.get("/api/info")
def api_info():
    return jsonify({
        "app_name": APP_NAME,
        "port": PORT,
        "phone_url": get_phone_url(),
        "pin_required": True,
    })


@app.post("/api/login")
def login():
    data = request.get_json(silent=True) or {}
    submitted_pin = str(data.get("pin", "")).strip()

    if (
        len(submitted_pin) == 4
        and submitted_pin.isdigit()
        and secrets.compare_digest(submitted_pin, ACCESS_PIN)
    ):
        session["authenticated"] = True

        return jsonify({
            "success": True,
            "message": "PIN accepted.",
        })

    return jsonify({
        "success": False,
        "message": "Incorrect PIN. Please try again.",
    }), 401


@app.post("/api/logout")
def logout():
    session.clear()

    return jsonify({"success": True})


@app.get("/api/files")
def list_files():
    if not require_pin():
        return jsonify({"error": "Please enter the PIN first."}), 401

    with FILES_LOCK:
        result = list(FILES.values())

    result.sort(key=lambda item: item["uploaded_at"])

    return jsonify({"files": result})


@app.post("/api/upload")
def upload_files():
    if not require_pin():
        return jsonify({"error": "Please enter the PIN first."}), 401

    incoming_files = request.files.getlist("files")

    if not incoming_files:
        return jsonify({
            "success": False,
            "message": "Please select at least one file.",
        }), 400

    uploaded = []
    rejected = []

    for file in incoming_files:
        if not file or not file.filename:
            continue

        original_name = safe_filename(file.filename)

        if not is_allowed_file(original_name):
            rejected.append({
                "name": original_name,
                "reason": "Unsupported file type.",
            })
            continue

        file_id = secrets.token_urlsafe(16)
        extension = Path(original_name).suffix.lower()

        stored_name = f"{file_id}{extension}"
        destination = UPLOAD_DIR / stored_name

        try:
            file.save(destination)

            file_size = destination.stat().st_size

            if file_size == 0:
                destination.unlink(missing_ok=True)
                rejected.append({
                    "name": original_name,
                    "reason": "The file is empty.",
                })
                continue

            uploaded_at = datetime.now().isoformat(
                timespec="seconds"
            )

            item = {
                "id": file_id,
                "name": original_name,
                "extension": extension,
                "size": file_size,
                "uploaded_at": uploaded_at,
                "preview_url": f"/api/files/{file_id}/preview",
            }

            with FILES_LOCK:
                FILES[file_id] = {
                    **item,
                    "path": str(destination),
                }

            uploaded.append(item)

        except OSError:
            rejected.append({
                "name": original_name,
                "reason": "Could not save this file.",
            })

    return jsonify({
        "success": len(uploaded) > 0,
        "uploaded": uploaded,
        "rejected": rejected,
    })


def get_file_record(file_id):
    with FILES_LOCK:
        record = FILES.get(file_id)

        if record is None:
            return None

        return dict(record)


@app.get("/api/files/<file_id>/preview")
def preview_file(file_id):
    if not require_pin():
        abort(401)

    record = get_file_record(file_id)

    if record is None:
        abort(404)

    path = Path(record["path"])

    if not path.is_file():
        abort(404)

    extension = record["extension"]

    mimetype = {
        ".pdf": "application/pdf",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".bmp": "image/bmp",
    }.get(extension, "application/octet-stream")

    return send_file(
        path,
        mimetype=mimetype,
        as_attachment=False,
        download_name=record["name"],
    )


@app.post("/api/files/<file_id>/delete")
def delete_file(file_id):
    if not require_pin():
        return jsonify({"error": "PIN required."}), 401

    with FILES_LOCK:
        record = FILES.pop(file_id, None)

    if record is None:
        return jsonify({
            "success": False,
            "message": "File not found.",
        }), 404

    try:
        Path(record["path"]).unlink(missing_ok=True)
    except OSError:
        pass

    return jsonify({"success": True})


@app.get("/health")
def health():
    return jsonify({
        "app": APP_NAME,
        "status": "running",
        "port": PORT,
    })


@app.errorhandler(413)
def file_too_large(error):
    return jsonify({
        "success": False,
        "message": "The upload is too large. Maximum size is 100 MB per request.",
    }), 413


def open_computer_page():
    webbrowser.open("http://127.0.0.1:8081/")


def main():
    ip_address = get_local_ip()

    print()
    print("=" * 42)
    print(f"        {APP_NAME}")
    print("=" * 42)
    print()
    print(f"Computer address: http://127.0.0.1:{PORT}/")
    print(f"Phone address:    http://{ip_address}:{PORT}/")
    print(f"PIN:              {ACCESS_PIN}")
    print()
    print("Scan the QR code displayed on the webpage.")
    print("Keep this program running while printing.")
    print("Press Ctrl+C to stop the server.")
    print()

    threading.Timer(1.0, open_computer_page).start()

    app.run(
        host="0.0.0.0",
        port=PORT,
        debug=False,
        threaded=True,
        use_reloader=False,
    )


if __name__ == "__main__":
    main()
```
