import { useState, useEffect, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Document, Page, pdfjs } from "react-pdf";
import {
    FileIcon,
    Loader2,
    AlertCircle,
    Image,
    FileText,
    Film,
    Music,
    Disc3,
    HardDrive,
    FileSpreadsheet,
    Presentation,
    FileCode,
    Archive,
    FileJson,
    Database,
    Box,
    Package,
    Lock,
    Settings,
    Binary
} from "lucide-react";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

// Set up PDF.js worker
pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

interface FilePreviewProps {
    bucket: string;
    fileKey: string;
    fileName: string;
    fileSize: number;
}

type FileType =
    | "image"
    | "pdf"
    | "video"
    | "audio"
    | "disc-image"      // ISO, IMG, etc.
    | "disk-image"      // DMG, sparse bundles
    | "word"            // doc, docx
    | "spreadsheet"     // xls, xlsx
    | "presentation"    // ppt, pptx
    | "archive"         // zip, tar, rar, 7z
    | "code"            // js, ts, py, etc.
    | "data"            // json, xml, yaml
    | "database"        // sql, db, sqlite
    | "executable"      // exe, app, bin
    | "package"         // pkg, deb, rpm
    | "encrypted"       // gpg, asc, key
    | "config"          // conf, ini, env
    | "text"            // txt, md, rtf
    | "font"            // ttf, otf, woff
    | "unknown";

// File type extensions
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg", "ico", "tiff", "tif", "heic", "heif", "raw", "cr2", "nef"];
const VIDEO_EXTENSIONS = ["mp4", "webm", "ogg", "mov", "avi", "mkv", "m4v", "wmv", "flv", "3gp", "mpeg", "mpg"];
const AUDIO_EXTENSIONS = ["mp3", "wav", "ogg", "m4a", "aac", "flac", "wma", "aiff", "alac", "opus"];
const PDF_EXTENSIONS = ["pdf"];
const DISC_IMAGE_EXTENSIONS = ["iso", "img", "bin", "cue", "nrg", "mdf", "mds", "toast"];
const DISK_IMAGE_EXTENSIONS = ["dmg", "sparsebundle", "sparseimage", "vhd", "vhdx", "vmdk", "qcow2"];
const WORD_EXTENSIONS = ["doc", "docx", "odt", "pages"];
const SPREADSHEET_EXTENSIONS = ["xls", "xlsx", "csv", "ods", "numbers"];
const PRESENTATION_EXTENSIONS = ["ppt", "pptx", "odp", "key"];
const ARCHIVE_EXTENSIONS = ["zip", "tar", "gz", "bz2", "xz", "7z", "rar", "tgz", "tbz2"];
const CODE_EXTENSIONS = ["js", "ts", "jsx", "tsx", "py", "rb", "go", "rs", "java", "c", "cpp", "h", "hpp", "cs", "php", "swift", "kt", "scala", "sh", "bash", "zsh", "ps1", "html", "css", "scss", "less", "vue", "svelte"];
const DATA_EXTENSIONS = ["json", "xml", "yaml", "yml", "toml"];
const DATABASE_EXTENSIONS = ["sql", "db", "sqlite", "sqlite3", "mdb", "accdb"];
const EXECUTABLE_EXTENSIONS = ["exe", "app", "bin", "msi", "apk", "ipa", "deb", "rpm"];
const PACKAGE_EXTENSIONS = ["pkg", "snap", "flatpak", "appimage"];
const ENCRYPTED_EXTENSIONS = ["gpg", "asc", "key", "pem", "crt", "cer", "p12", "pfx"];
const CONFIG_EXTENSIONS = ["conf", "config", "ini", "env", "properties", "cfg"];
const TEXT_EXTENSIONS = ["txt", "md", "rtf", "log", "readme"];
const FONT_EXTENSIONS = ["ttf", "otf", "woff", "woff2", "eot"];

// Max file size for actual preview (50MB)
const MAX_PREVIEW_SIZE = 50 * 1024 * 1024;

function getFileExtension(fileName: string): string {
    const parts = fileName.split(".");
    return parts.length > 1 ? parts.pop()!.toLowerCase() : "";
}

function getFileType(fileName: string): FileType {
    const ext = getFileExtension(fileName);
    if (IMAGE_EXTENSIONS.includes(ext)) return "image";
    if (VIDEO_EXTENSIONS.includes(ext)) return "video";
    if (AUDIO_EXTENSIONS.includes(ext)) return "audio";
    if (PDF_EXTENSIONS.includes(ext)) return "pdf";
    if (DISC_IMAGE_EXTENSIONS.includes(ext)) return "disc-image";
    if (DISK_IMAGE_EXTENSIONS.includes(ext)) return "disk-image";
    if (WORD_EXTENSIONS.includes(ext)) return "word";
    if (SPREADSHEET_EXTENSIONS.includes(ext)) return "spreadsheet";
    if (PRESENTATION_EXTENSIONS.includes(ext)) return "presentation";
    if (ARCHIVE_EXTENSIONS.includes(ext)) return "archive";
    if (CODE_EXTENSIONS.includes(ext)) return "code";
    if (DATA_EXTENSIONS.includes(ext)) return "data";
    if (DATABASE_EXTENSIONS.includes(ext)) return "database";
    if (EXECUTABLE_EXTENSIONS.includes(ext)) return "executable";
    if (PACKAGE_EXTENSIONS.includes(ext)) return "package";
    if (ENCRYPTED_EXTENSIONS.includes(ext)) return "encrypted";
    if (CONFIG_EXTENSIONS.includes(ext)) return "config";
    if (TEXT_EXTENSIONS.includes(ext)) return "text";
    if (FONT_EXTENSIONS.includes(ext)) return "font";
    return "unknown";
}

// Types that can be actually previewed (fetch content)
const PREVIEWABLE_TYPES: FileType[] = ["image", "video", "audio", "pdf"];

// Get icon and colors for each file type
function getFileTypeDisplay(fileType: FileType): { icon: ReactNode; label: string; bgColor: string } {
    switch (fileType) {
        case "image":
            return {
                icon: <Image className="w-16 h-16 text-blue-500" />,
                label: "Image",
                bgColor: "bg-blue-50"
            };
        case "video":
            return {
                icon: <Film className="w-16 h-16 text-purple-500" />,
                label: "Video",
                bgColor: "bg-purple-50"
            };
        case "audio":
            return {
                icon: <Music className="w-16 h-16 text-green-500" />,
                label: "Audio",
                bgColor: "bg-green-50"
            };
        case "pdf":
            return {
                icon: <FileText className="w-16 h-16 text-red-500" />,
                label: "PDF Document",
                bgColor: "bg-red-50"
            };
        case "disc-image":
            return {
                icon: <Disc3 className="w-16 h-16 text-gray-600" />,
                label: "Disc Image",
                bgColor: "bg-gray-100"
            };
        case "disk-image":
            return {
                icon: <HardDrive className="w-16 h-16 text-gray-600" />,
                label: "Disk Image",
                bgColor: "bg-gray-100"
            };
        case "word":
            return {
                icon: <FileText className="w-16 h-16 text-blue-600" />,
                label: "Word Document",
                bgColor: "bg-blue-50"
            };
        case "spreadsheet":
            return {
                icon: <FileSpreadsheet className="w-16 h-16 text-green-600" />,
                label: "Spreadsheet",
                bgColor: "bg-green-50"
            };
        case "presentation":
            return {
                icon: <Presentation className="w-16 h-16 text-orange-500" />,
                label: "Presentation",
                bgColor: "bg-orange-50"
            };
        case "archive":
            return {
                icon: <Archive className="w-16 h-16 text-amber-600" />,
                label: "Archive",
                bgColor: "bg-amber-50"
            };
        case "code":
            return {
                icon: <FileCode className="w-16 h-16 text-indigo-500" />,
                label: "Source Code",
                bgColor: "bg-indigo-50"
            };
        case "data":
            return {
                icon: <FileJson className="w-16 h-16 text-yellow-600" />,
                label: "Data File",
                bgColor: "bg-yellow-50"
            };
        case "database":
            return {
                icon: <Database className="w-16 h-16 text-cyan-600" />,
                label: "Database",
                bgColor: "bg-cyan-50"
            };
        case "executable":
            return {
                icon: <Binary className="w-16 h-16 text-rose-600" />,
                label: "Executable",
                bgColor: "bg-rose-50"
            };
        case "package":
            return {
                icon: <Package className="w-16 h-16 text-violet-600" />,
                label: "Package",
                bgColor: "bg-violet-50"
            };
        case "encrypted":
            return {
                icon: <Lock className="w-16 h-16 text-emerald-600" />,
                label: "Encrypted",
                bgColor: "bg-emerald-50"
            };
        case "config":
            return {
                icon: <Settings className="w-16 h-16 text-slate-500" />,
                label: "Config File",
                bgColor: "bg-slate-50"
            };
        case "text":
            return {
                icon: <FileText className="w-16 h-16 text-gray-500" />,
                label: "Text File",
                bgColor: "bg-gray-50"
            };
        case "font":
            return {
                icon: <Box className="w-16 h-16 text-pink-500" />,
                label: "Font",
                bgColor: "bg-pink-50"
            };
        default:
            return {
                icon: <FileIcon className="w-16 h-16 text-gray-400" />,
                label: "File",
                bgColor: "bg-gray-50"
            };
    }
}

// Icon-only display component
function FileTypeIcon({ fileType }: { fileType: FileType }) {
    const { icon, label, bgColor } = getFileTypeDisplay(fileType);
    return (
        <div className={`flex flex-col items-center justify-center p-6 ${bgColor} rounded-xl`}>
            {icon}
            <span className="text-xs text-gray-500 mt-3 font-medium">{label}</span>
        </div>
    );
}

export function FilePreview({ bucket, fileKey, fileName, fileSize }: FilePreviewProps) {
    const [url, setUrl] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [numPages, setNumPages] = useState<number | null>(null);
    const [currentPage, setCurrentPage] = useState(1);

    const fileType = getFileType(fileName);
    const canPreview = PREVIEWABLE_TYPES.includes(fileType) && fileSize <= MAX_PREVIEW_SIZE;

    useEffect(() => {
        let mounted = true;

        const loadPreview = async () => {
            if (!canPreview) {
                setLoading(false);
                return;
            }

            try {
                setLoading(true);
                setError(null);
                const presignedUrl = await invoke<string>("get_presigned_url", {
                    bucket,
                    key: fileKey,
                    expiresInSecs: 3600, // 1 hour
                });
                if (mounted) {
                    setUrl(presignedUrl);
                }
            } catch (err) {
                if (mounted) {
                    setError(err instanceof Error ? err.message : String(err));
                }
            } finally {
                if (mounted) {
                    setLoading(false);
                }
            }
        };

        loadPreview();

        return () => {
            mounted = false;
        };
    }, [bucket, fileKey, canPreview]);

    const onDocumentLoadSuccess = ({ numPages }: { numPages: number }) => {
        setNumPages(numPages);
        setCurrentPage(1);
    };

    // For non-previewable types, just show the icon
    if (!canPreview) {
        return <FileTypeIcon fileType={fileType} />;
    }

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center h-48 text-gray-400">
                <Loader2 className="w-8 h-8 animate-spin mb-2" />
                <span className="text-xs">Loading preview...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center h-48 text-red-400">
                <AlertCircle className="w-8 h-8 mb-2" />
                <span className="text-xs text-center px-4">Preview failed</span>
            </div>
        );
    }

    // Render actual preview based on file type
    switch (fileType) {
        case "image":
            return (
                <div className="flex items-center justify-center p-2 bg-gray-100 rounded-lg">
                    <img
                        src={url!}
                        alt={fileName}
                        className="max-w-full max-h-64 object-contain rounded"
                        onError={() => setError("Failed to load image")}
                    />
                </div>
            );

        case "video":
            return (
                <div className="flex items-center justify-center p-2 bg-black rounded-lg">
                    <video
                        src={url!}
                        controls
                        className="max-w-full max-h-64 rounded"
                        onError={() => setError("Failed to load video")}
                    >
                        Your browser does not support video playback.
                    </video>
                </div>
            );

        case "audio":
            return (
                <div className="flex flex-col items-center justify-center p-4 bg-green-50 rounded-lg">
                    <Music className="w-12 h-12 text-green-500 mb-4" />
                    <audio
                        src={url!}
                        controls
                        className="w-full"
                        onError={() => setError("Failed to load audio")}
                    >
                        Your browser does not support audio playback.
                    </audio>
                </div>
            );

        case "pdf":
            return (
                <div className="flex flex-col items-center bg-gray-100 rounded-lg p-2">
                    <Document
                        file={url!}
                        onLoadSuccess={onDocumentLoadSuccess}
                        onLoadError={() => setError("Failed to load PDF")}
                        loading={
                            <div className="flex items-center justify-center h-48">
                                <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
                            </div>
                        }
                    >
                        <Page
                            pageNumber={currentPage}
                            width={240}
                            renderTextLayer={false}
                            renderAnnotationLayer={false}
                        />
                    </Document>
                    {numPages && numPages > 1 && (
                        <div className="flex items-center gap-2 mt-2 text-xs text-gray-600">
                            <button
                                onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                disabled={currentPage <= 1}
                                className="px-2 py-1 bg-white rounded hover:bg-gray-200 disabled:opacity-50"
                            >
                                Prev
                            </button>
                            <span>{currentPage} / {numPages}</span>
                            <button
                                onClick={() => setCurrentPage(p => Math.min(numPages, p + 1))}
                                disabled={currentPage >= numPages}
                                className="px-2 py-1 bg-white rounded hover:bg-gray-200 disabled:opacity-50"
                            >
                                Next
                            </button>
                        </div>
                    )}
                </div>
            );

        default:
            return <FileTypeIcon fileType={fileType} />;
    }
}
