```javascript
"use strict";

const $ = (id) => document.getElementById(id);

let uploadedFiles = [];
let activePreviewUrl = null;

const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".bmp"];
const PDF_EXTENSION = ".pdf";

function showMessage(element, message, type = "") {
    element.textContent = message;
    element.className = "message";

    if (type) {
        element.classList.add(type);
    }
}

function formatSize(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function extensionOf(file) {
    return (file.extension || "").toLowerCase();
}

function isPdf(file) {
    return extensionOf(file) === PDF_EXTENSION;
}

function isImage(file) {
    return IMAGE_EXTENSIONS.includes(extensionOf(file));
}

async function api(url, options = {}) {
    const response = await fetch(url, {
        credentials: "same-origin",
        ...options
    });

    let data = {};

    try {
        data = await response.json();
    } catch {
        // The response may not contain JSON.
    }

    if (!response.ok) {
        throw new Error(
            data.message ||
            data.error ||
            `Request failed (${response.status}).`
        );
    }

    return data;
}

async function loadServerInfo() {
    try {
        const info = await api("/api/info");

        $("phoneAddress").textContent = info.phone_url;
        $("qrImage").src = "/qr.png";

        $("connectionStatus").textContent = "Server ready";
    } catch (error) {
        $("connectionStatus").textContent = "Connection error";
        $("phoneAddress").textContent = error.message;
    }
}

async function login(event) {
    event.preventDefault();

    const pin = $("pinInput").value.trim();

    if (!/^\d{4}$/.test(pin)) {
        showMessage(
            $("loginMessage"),
            "Enter all four digits of your PIN.",
            "error"
        );
        return;
    }

    const button = event.submitter;

    if (button) {
        button.disabled = true;
    }

    try {
        const result = await api("/api/login", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ pin })
        });

        if (result.success) {
            $("loginSection").hidden = true;
            $("mainSection").hidden = false;

            showMessage($("loginMessage"), "");
            await refreshFiles();
        }
    } catch (error) {
        showMessage($("loginMessage"), error.message, "error");
    } finally {
        if (button) {
            button.disabled = false;
        }
    }
}

function updateSelectedFiles() {
    const files = Array.from($("fileInput").files);

    if (files.length === 0) {
        $("selectedFiles").textContent = "No files selected.";
        return;
    }

    const totalSize = files.reduce((sum, file) => sum + file.size, 0);

    $("selectedFiles").textContent =
        `${files.length} file(s) selected · ${formatSize(totalSize)}`;
}

async function uploadFiles(event) {
    event.preventDefault();

    const selected = Array.from($("fileInput").files);

    if (selected.length === 0) {
        showMessage(
            $("uploadMessage"),
            "Please select at least one file.",
            "error"
        );
        return;
    }

    const formData = new FormData();

    selected.forEach((file) => {
        formData.append("files", file);
    });

    const button = $("uploadButton");
    button.disabled = true;
    button.textContent = "Uploading...";

    showMessage($("uploadMessage"), "Uploading files...");

    try {
        const result = await api("/api/upload", {
            method: "POST",
            body: formData
        });

        const uploadedCount = (result.uploaded || []).length;
        const rejectedCount = (result.rejected || []).length;

        let message = `${uploadedCount} file(s) uploaded successfully.`;

        if (rejectedCount > 0) {
            const rejectedNames = result.rejected
                .map((item) => item.name)
                .join(", ");

            message += ` Rejected: ${rejectedNames}.`;
        }

        showMessage(
            $("uploadMessage"),
            message,
            uploadedCount > 0 ? "success" : "error"
        );

        $("fileInput").value = "";
        updateSelectedFiles();

        await refreshFiles();
    } catch (error) {
        showMessage($("uploadMessage"), error.message, "error");
    } finally {
        button.disabled = false;
        button.textContent = "Upload selected files";
    }
}

function createButton(label, className, callback) {
    const button = document.createElement("button");

    button.type = "button";
    button.textContent = label;
    button.className = className;
    button.addEventListener("click", callback);

    return button;
}

function renderFiles() {
    const list = $("fileList");
    list.replaceChildren();

    if (uploadedFiles.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "No files uploaded yet.";

        list.appendChild(empty);
    }

    uploadedFiles.forEach((file) => {
        const item = document.createElement("article");
        item.className = "file-item";

        const icon = document.createElement("div");
        icon.className = "file-icon";
        icon.textContent = isPdf(file) ? "PDF" : "IMAGE";

        const info = document.createElement("div");
        info.className = "file-info";

        const name = document.createElement("h3");
        name.textContent = file.name;

        const details = document.createElement("p");
        details.textContent =
            `${formatSize(file.size)} · ${extensionOf(file).toUpperCase()}`;

        info.append(name, details);

        const actions = document.createElement("div");
        actions.className = "file-actions";

        actions.appendChild(
            createButton("Preview", "", () => previewFile(file))
        );

        actions.appendChild(
            createButton("Print", "print-button", () => printFile(file))
        );

        actions.appendChild(
            createButton("Remove", "delete-button", () => deleteFile(file))
        );

        item.append(icon, info, actions);
        list.appendChild(item);
    });

    const pdfs = uploadedFiles.filter(isPdf);
    const images = uploadedFiles.filter(isImage);

    $("pdfSummary").textContent = `${pdfs.length} PDF file(s)`;
    $("imageSummary").textContent = `${images.length} image file(s)`;

    $("printAllPdfButton").disabled = pdfs.length === 0;
    $("printAllImagesButton").disabled = images.length === 0;
}

async function refreshFiles() {
    try {
        const result = await api("/api/files");

        uploadedFiles = result.files || [];
        renderFiles();
    } catch (error) {
        console.error("Could not refresh file list:", error);
    }
}

function openPreview(file) {
    const url = `/api/files/${encodeURIComponent(file.id)}/preview`;

    $("previewTitle").textContent = file.name;
    $("previewFrame").src = url;

    $("previewModal").hidden = false;

    if (activePreviewUrl) {
        URL.revokeObjectURL(activePreviewUrl);
        activePreviewUrl = null;
    }
}

function previewFile(file) {
    openPreview(file);
}

function closePreview() {
    $("previewModal").hidden = true;
    $("previewFrame").src = "about:blank";

    if (activePreviewUrl) {
        URL.revokeObjectURL(activePreviewUrl);
        activePreviewUrl = null;
    }
}

function printFile(file) {
    openPreview(file);

    $("printPreviewButton").onclick = () => {
        const frame = $("previewFrame");

        try {
            frame.contentWindow.focus();
            frame.contentWindow.print();
        } catch (error) {
            window.open(
                `/api/files/${encodeURIComponent(file.id)}/preview`,
                "_blank"
            );
        }
    };
}

async function deleteFile(file) {
    const confirmed = window.confirm(
        `Remove "${file.name}" from QR Print?`
    );

    if (!confirmed) {
        return;
    }

    try {
        await api(`/api/files/${encodeURIComponent(file.id)}/delete`, {
            method: "POST"
        });

        await refreshFiles();
    } catch (error) {
        window.alert(error.message);
    }
}

function printAll(group) {
    const files = uploadedFiles.filter(
        group === "pdf" ? isPdf : isImage
    );

    if (files.length === 0) {
        return;
    }

    const message =
        `This will open ${files.length} ${group.toUpperCase()} file(s). ` +
        "Printing settings depend on your browser and printer.";

    if (!window.confirm(message)) {
        return;
    }

    files.forEach((file) => {
        const url =
            `/api/files/${encodeURIComponent(file.id)}/preview`;

        window.open(url, "_blank", "noopener");
    });
}

function openComputerPage() {
    const localAddress = window.location.hostname;

    if (
        localAddress === "localhost" ||
        localAddress === "127.0.0.1"
    ) {
        window.location.href = "/";
        return;
    }

    window.alert(
        "Open the QR Print program on your computer to access " +
        "Windows printer settings."
    );
}

async function logout() {
    try {
        await api("/api/logout", {
            method: "POST"
        });
    } catch (error) {
        console.error("Logout failed:", error);
    }

    uploadedFiles = [];

    $("mainSection").hidden = true;
    $("loginSection").hidden = false;
    $("pinInput").value = "";

    showMessage($("loginMessage"), "Disconnected.", "success");
}

$("loginForm").addEventListener("submit", login);
$("uploadForm").addEventListener("submit", uploadFiles);

$("fileInput").addEventListener("change", updateSelectedFiles);

$("refreshButton").addEventListener("click", refreshFiles);

$("closePreviewButton").addEventListener("click", closePreview);

$("previewModal").addEventListener("click", (event) => {
    if (event.target === $("previewModal")) {
        closePreview();
    }
});

$("printAllPdfButton").addEventListener("click", () => {
    printAll("pdf");
});

$("printAllImagesButton").addEventListener("click", () => {
    printAll("images");
});

$("openComputerButton").addEventListener("click", openComputerPage);
$("logoutButton").addEventListener("click", logout);

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        closePreview();
    }
});

loadServerInfo();
```
