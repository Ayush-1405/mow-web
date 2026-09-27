import { useEffect, useRef, useState } from "react";
import { validateUploadFile } from "./fileTypes";

// Shared "take/choose a photo, preview it locally, retake/remove" logic for a photo-first capture flow (used by
// Godown Stock Intake and Retail Add Product — both need the exact same behavior: the photo is picked BEFORE any
// database row exists, held only as a local URL.createObjectURL() preview (revoked on retake/remove/unmount, never
// persisted, never uploaded merely because the picker opened), and only actually uploaded later once the caller
// has everything else it needs (e.g. a location) to create the real record.
export function usePhotoCapture() {
  const fileInputRef = useRef(null);
  const galleryInputRef = useRef(null);
  const previewUrlRef = useRef(null);
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => { previewUrlRef.current = previewUrl; }, [previewUrl]);
  useEffect(() => () => { if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current); }, []);

  async function handleSelected(e) {
    const picked = e.target.files?.[0];
    e.target.value = "";
    if (!picked) return;
    setError(null);
    try {
      // Real content validation (extension + browser MIME, HEIC/HEIF included) — never trusts the extension alone,
      // and gives a specific message instead of letting an unsupported file fail later as a generic 400.
      await validateUploadFile(picked, "image");
      if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
      setFile(picked);
      setPreviewUrl(URL.createObjectURL(picked));
    } catch (err) {
      setError(err.message || String(err));
    }
  }

  function remove() {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    setFile(null);
    setPreviewUrl(null);
    setError(null);
  }

  return {
    file, previewUrl, error, fileInputRef, galleryInputRef, handleSelected, remove,
    openCamera: () => fileInputRef.current?.click(),
    openGallery: () => galleryInputRef.current?.click(),
  };
}
