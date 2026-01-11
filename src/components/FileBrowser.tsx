
import React, { useEffect, useState, useCallback, useRef } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { save, open } from "@tauri-apps/plugin-dialog";
import { cn } from "../lib/cn";
import { FilePreview } from "./FilePreview";
import {
    Folder,
    File as FileIcon,
    ChevronLeft,
    ChevronRight,
    ChevronUp,
    ChevronDown,
    Search,
    Plus,
    Loader2,
    Download,
    Trash2,
    FolderPlus,
    Upload,
    ArrowUp,
    ArrowDown,
    Play,
    Pause,
    X,
    Trash,
    List,
    Columns,
    FileText
} from "lucide-react";

interface FileObject {
    key: string;
    size: number;
    last_modified: string;
    is_dir: boolean;
}

interface UploadProgress {
    filename: string;
    current_file: number;
    total_files: number;
    bytes_uploaded: number;
    total_bytes: number;
    percent: number;
}

interface DownloadProgress {
    filename: string;
    current_file: number;
    total_files: number;
    bytes_downloaded: number;
    total_bytes: number;
    percent: number;
}

interface QueuedUpload {
    id: string;
    filePath: string;
    fileName: string;
    targetKey: string;
    targetFolder: string; // The folder path where this upload was initiated
    status: 'pending' | 'uploading' | 'complete' | 'error' | 'paused';
    retryCount?: number;
    lastError?: string;
}

interface StorageStats {
    used_bytes: number;
    total_bytes: number;
    object_count: number;
}

interface CacheStatus {
    is_fresh: boolean;
    last_sync: number | null;
    item_count: number;
}

interface ListResult {
    files: FileObject[];
    from_cache: boolean;
    cache_status: CacheStatus;
}

const UPLOAD_QUEUE_STORAGE_KEY = 'mosaic-drive-upload-queue';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000; // 2 seconds base delay

interface FileBrowserProps {
    initialBucket: string;
}

// Column View Component for Finder-style multi-column navigation
interface ColumnData {
    path: string;
    files: FileObject[];
    selectedKey: string | null;
    loading: boolean;
}

interface ColumnViewProps {
    bucket: string;
    initialPath: string;
    isTrashView: boolean;
    isDragOver: boolean;
    onNavigate: (path: string) => void;
    onDownload: (e: React.MouseEvent, file: FileObject) => void;
    onDelete: (e: React.MouseEvent, file: FileObject) => void;
    formatDate: (dateStr: string) => string;
    formatSize: (bytes: number) => string;
    // Drag and drop props
    draggedFiles: string[];
    draggedFilesRef: React.RefObject<string[]>;
    setDraggedFiles: (files: string[]) => void;
    dropTargetFolder: string | null;
    onDragEnterFolder: (folderKey: string) => void;
    onDragLeaveFolder: (folderKey: string) => void;
    resetDragCounters: () => void;
    onMoveFiles: (keys: string[], targetFolder: string) => void;
}

function ColumnView({ bucket, initialPath, isTrashView, isDragOver, onNavigate, onDownload, onDelete, formatDate, formatSize, draggedFiles, draggedFilesRef, setDraggedFiles, dropTargetFolder, onDragEnterFolder, onDragLeaveFolder, resetDragCounters, onMoveFiles }: ColumnViewProps) {
    const [columns, setColumns] = useState<ColumnData[]>([]);
    const [selectedFile, setSelectedFile] = useState<FileObject | null>(null);
    const scrollContainerRef = React.useRef<HTMLDivElement>(null);

    // Helper to filter .keep files
    const filterFiles = (files: FileObject[]) => {
        return files.filter(file => {
            const fileName = file.key.split('/').filter(Boolean).pop() || '';
            if (fileName === '.keep' || fileName === '.gitkeep') return false;
            if (!isTrashView && file.key.startsWith('.Trash')) return false;
            return true;
        }).sort((a, b) => {
            if (a.is_dir && !b.is_dir) return -1;
            if (!a.is_dir && b.is_dir) return 1;
            return a.key.localeCompare(b.key);
        });
    };

    // Load files for a given path
    const loadFilesForPath = async (path: string): Promise<FileObject[]> => {
        try {
            const list = await invoke<FileObject[]>("list_objects", { bucket, prefix: path });
            return filterFiles(list);
        } catch (err) {
            console.error("Failed to load files for path:", path, err);
            return [];
        }
    };

    // Initialize columns based on initialPath
    useEffect(() => {
        const initializeColumns = async () => {
            // Parse the path into segments
            const pathParts = initialPath.split('/').filter(Boolean);
            const newColumns: ColumnData[] = [];

            // Skip root column - root folders are already in sidebar
            // Start from the first path segment (the selected root folder)
            if (pathParts.length === 0) {
                // No path selected - show empty state
                setColumns([]);
                setSelectedFile(null);
                return;
            }

            // Start from first folder (root folder contents)
            let currentPath = pathParts[0] + '/';
            const firstFiles = await loadFilesForPath(currentPath);
            const firstSelected = pathParts.length > 1 ? pathParts.slice(0, 2).join('/') + '/' : null;
            newColumns.push({
                path: currentPath,
                files: firstFiles,
                selectedKey: firstSelected,
                loading: false
            });

            // Add columns for remaining path segments
            for (let i = 1; i < pathParts.length; i++) {
                currentPath = pathParts.slice(0, i + 1).join('/') + '/';
                const files = await loadFilesForPath(currentPath);
                const nextSelected = i < pathParts.length - 1 ? pathParts.slice(0, i + 2).join('/') + '/' : null;
                newColumns.push({
                    path: currentPath,
                    files,
                    selectedKey: nextSelected,
                    loading: false
                });
            }

            setColumns(newColumns);
            setSelectedFile(null);
        };

        initializeColumns();
    }, [initialPath, bucket, isTrashView]);

    // Auto-scroll to the right when new columns are added
    useEffect(() => {
        if (scrollContainerRef.current) {
            scrollContainerRef.current.scrollLeft = scrollContainerRef.current.scrollWidth;
        }
    }, [columns.length]);

    const handleItemClick = async (file: FileObject, columnIndex: number) => {
        const isMacBundle = /\.(app|framework|bundle|plugin|kext)$/i.test(file.key);
        const isFolder = file.is_dir && !isMacBundle && !isTrashView;

        // Update selection in the clicked column
        setColumns(prev => {
            const updated = [...prev];
            updated[columnIndex] = { ...updated[columnIndex], selectedKey: file.key };
            // Remove all columns after this one
            return updated.slice(0, columnIndex + 1);
        });

        if (isFolder) {
            // Load files for the folder and add new column
            setSelectedFile(null);

            // Add loading column first
            setColumns(prev => [
                ...prev,
                { path: file.key, files: [], selectedKey: null, loading: true }
            ]);

            const files = await loadFilesForPath(file.key);

            setColumns(prev => {
                const updated = [...prev];
                const lastIdx = updated.length - 1;
                if (updated[lastIdx]?.path === file.key) {
                    updated[lastIdx] = { path: file.key, files, selectedKey: null, loading: false };
                }
                return updated;
            });

            // Update the main path for other features (upload target, etc.)
            onNavigate(file.key);
        } else {
            // File selected - show preview
            setSelectedFile(file);
        }
    };

    const getFileName = (key: string) => {
        return key.split('/').filter(Boolean).pop() || '';
    };

    // Empty state when no folder selected
    if (columns.length === 0) {
        return (
            <div className="flex-1 flex items-center justify-center bg-gray-50">
                <p className="text-gray-400 text-sm">Select a folder from the sidebar</p>
            </div>
        );
    }

    return (
        <div ref={scrollContainerRef} className="flex h-full overflow-x-auto relative">
            {/* Drop Zone Overlay for Column View - only show for external uploads, not internal moves */}
            {isDragOver && draggedFiles.length === 0 && (
                <div className="absolute inset-0 z-50 bg-blue-500/10 border-2 border-dashed border-blue-500 rounded-lg m-2 flex items-center justify-center pointer-events-none">
                    <div className="text-center">
                        <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-100 flex items-center justify-center">
                            <Plus className="w-8 h-8 text-blue-600" />
                        </div>
                        <p className="text-blue-600 font-semibold text-lg">Drop files here</p>
                        <p className="text-blue-500/70 text-sm mt-1">Upload to {initialPath || "root"}</p>
                    </div>
                </div>
            )}
            {/* Render each column */}
            {columns.map((column, colIndex) => (
                <div
                    key={column.path || 'root'}
                    className="min-w-[220px] w-[220px] border-r border-gray-200 flex flex-col bg-white flex-shrink-0"
                >
                    <div className="flex-1 overflow-y-auto">
                        {column.loading ? (
                            <div className="p-4 flex justify-center">
                                <Loader2 className="w-5 h-5 text-blue-500 animate-spin" />
                            </div>
                        ) : column.files.length === 0 ? (
                            <div className="p-4 text-center text-gray-400 text-xs">
                                {isTrashView ? "Empty" : "Empty folder"}
                            </div>
                        ) : (
                            column.files.map((file) => {
                                const fileName = getFileName(file.key);
                                const isMacBundle = /\.(app|framework|bundle|plugin|kext)$/i.test(fileName);
                                const isFolder = file.is_dir && !isMacBundle && !isTrashView;
                                const isSelected = column.selectedKey === file.key;
                                const isDragTarget = isFolder && dropTargetFolder === file.key;
                                const isBeingDragged = draggedFiles.includes(file.key);

                                return (
                                    <div
                                        key={file.key}
                                        draggable={!isTrashView && !isFolder}
                                        onDragStart={(e) => {
                                            if (isTrashView || isFolder) return;
                                            setDraggedFiles([file.key]);
                                            e.dataTransfer.effectAllowed = 'move';
                                            e.dataTransfer.setData('application/x-mosaic-files', JSON.stringify([file.key]));
                                        }}
                                        onDragEnd={() => {
                                            setDraggedFiles([]);
                                            resetDragCounters();
                                        }}
                                        onDragOver={(e) => {
                                            if (isFolder && draggedFilesRef.current && draggedFilesRef.current.length > 0) {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                e.dataTransfer.dropEffect = 'move';
                                            }
                                        }}
                                        onDragEnter={(e) => {
                                            if (isFolder && draggedFilesRef.current && draggedFilesRef.current.length > 0) {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                onDragEnterFolder(file.key);
                                            }
                                        }}
                                        onDragLeave={(e) => {
                                            if (isFolder && draggedFilesRef.current && draggedFilesRef.current.length > 0) {
                                                e.stopPropagation();
                                                onDragLeaveFolder(file.key);
                                            }
                                        }}
                                        onDrop={(e) => {
                                            e.preventDefault();
                                            e.stopPropagation();
                                            if (isFolder && draggedFilesRef.current && draggedFilesRef.current.length > 0) {
                                                onMoveFiles(draggedFilesRef.current, file.key);
                                            }
                                            setDraggedFiles([]);
                                            resetDragCounters();
                                        }}
                                        onClick={() => handleItemClick(file, colIndex)}
                                        onDoubleClick={(e) => {
                                            e.preventDefault();
                                            if (!isFolder && !isTrashView) {
                                                onDownload(e, file);
                                            }
                                        }}
                                        className={cn(
                                            "flex items-center gap-2 px-3 py-1 cursor-pointer transition-colors select-none",
                                            isSelected && !isDragTarget
                                                ? "bg-blue-500 text-white"
                                                : !isDragTarget && "hover:bg-gray-100",
                                            isDragTarget && "!bg-green-200 ring-2 ring-green-500 text-green-800",
                                            isBeingDragged && "opacity-50"
                                        )}
                                    >
                                        {isFolder ? (
                                            <Folder className={cn("w-4 h-4 flex-shrink-0", isSelected ? "text-white" : "text-blue-500 fill-blue-500/20")} />
                                        ) : (
                                            <FileIcon className={cn("w-4 h-4 flex-shrink-0", isSelected ? "text-white" : "text-gray-400")} />
                                        )}
                                        <span className={cn("truncate text-xs flex-1", isSelected ? "text-white" : "text-gray-700")}>
                                            {fileName}
                                        </span>
                                        {isFolder && (
                                            <ChevronRight className={cn("w-3 h-3 flex-shrink-0", isSelected ? "text-white" : "text-gray-300")} />
                                        )}
                                    </div>
                                );
                            })
                        )}
                    </div>
                </div>
            ))}

            {/* Preview/Details column */}
            {selectedFile && !selectedFile.is_dir && (
                <div className="min-w-[280px] max-w-[320px] flex-1 bg-gray-50 p-4 overflow-y-auto flex-shrink-0">
                    <div className="flex flex-col items-center text-center">
                        {/* File Preview */}
                        <div className="w-full mb-4">
                            <FilePreview
                                bucket={bucket}
                                fileKey={selectedFile.key}
                                fileName={getFileName(selectedFile.key)}
                                fileSize={selectedFile.size}
                            />
                        </div>
                        <h3 className="font-semibold text-gray-900 mb-1 break-all text-sm">
                            {getFileName(selectedFile.key)}
                        </h3>
                        <div className="text-sm text-gray-500 space-y-1 mt-4 w-full text-left">
                            <div className="flex justify-between py-2 border-b border-gray-200">
                                <span className="text-gray-400 text-xs">Size</span>
                                <span className="font-medium text-xs">{formatSize(selectedFile.size)}</span>
                            </div>
                            <div className="flex justify-between py-2 border-b border-gray-200">
                                <span className="text-gray-400 text-xs">Modified</span>
                                <span className="font-medium text-xs">{formatDate(selectedFile.last_modified)}</span>
                            </div>
                            <div className="flex justify-between py-2">
                                <span className="text-gray-400 text-xs">Path</span>
                                <span className="font-medium text-xs break-all">{selectedFile.key}</span>
                            </div>
                        </div>
                        <div className="flex gap-2 mt-6">
                            {!isTrashView && (
                                <button
                                    onClick={(e) => onDownload(e, selectedFile)}
                                    className="px-3 py-1.5 bg-blue-600 text-white rounded-lg text-xs font-medium hover:bg-blue-700 transition-colors flex items-center gap-1.5"
                                >
                                    <Download className="w-3.5 h-3.5" />
                                    Download
                                </button>
                            )}
                            <button
                                onClick={(e) => onDelete(e, selectedFile)}
                                className="px-3 py-1.5 bg-red-50 text-red-600 rounded-lg text-xs font-medium hover:bg-red-100 transition-colors flex items-center gap-1.5"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                                {isTrashView ? "Delete" : "Trash"}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export function FileBrowser({ initialBucket }: FileBrowserProps) {
    const [rootFolders, setRootFolders] = useState<string[]>([]);
    const [currentPath, setCurrentPath] = useState<string>("");
    const [files, setFiles] = useState<FileObject[]>([]);
    const [loading, setLoading] = useState(false);
    const [loadingTooLong, setLoadingTooLong] = useState(false);
    const [isFromCache, setIsFromCache] = useState(false);
    const [_isRefreshing, setIsRefreshing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [successMessage, setSuccessMessage] = useState<string | null>(null);
    const [uploading, setUploading] = useState(false);
    const [uploadProgressMap, setUploadProgressMap] = useState<Record<string, UploadProgress>>({});
    const [uploadSpeed, setUploadSpeed] = useState<number>(0); // bytes per second
    const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
    const [uploadQueue, setUploadQueue] = useState<QueuedUpload[]>(() => {
        // Initialize from localStorage
        try {
            const saved = localStorage.getItem(UPLOAD_QUEUE_STORAGE_KEY);
            if (saved) {
                const parsed = JSON.parse(saved) as QueuedUpload[];
                // Reset any 'uploading' items to 'pending' and ensure all required fields exist
                return parsed.map(item => ({
                    ...item,
                    status: item.status === 'uploading' ? 'pending' as const : item.status,
                    // Ensure targetFolder exists (for items saved before this field was added)
                    targetFolder: item.targetFolder || item.targetKey?.split('/').slice(0, -1).join('/') + '/' || ''
                })).filter(item => item.status !== 'complete'); // Remove completed items
            }
        } catch (e) {
            console.error('Failed to load upload queue from storage:', e);
            // Clear corrupted data
            localStorage.removeItem(UPLOAD_QUEUE_STORAGE_KEY);
        }
        return [];
    });

    // Persist upload queue to localStorage
    useEffect(() => {
        try {
            // Only save pending/paused/error items (not uploading or complete)
            const toSave = uploadQueue.filter(item =>
                item.status === 'pending' || item.status === 'paused' || item.status === 'error'
            );
            if (toSave.length > 0) {
                localStorage.setItem(UPLOAD_QUEUE_STORAGE_KEY, JSON.stringify(toSave));
            } else {
                localStorage.removeItem(UPLOAD_QUEUE_STORAGE_KEY);
            }
        } catch (e) {
            console.error('Failed to save upload queue:', e);
        }
    }, [uploadQueue]);

    // Ref for upload speed calculation - uses time-based accumulator
    const uploadBytesAccumRef = React.useRef<{ bytes: number; startTime: number; lastUpdate: number }>({ bytes: 0, startTime: 0, lastUpdate: 0 });

    // Download progress state
    const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
    const [downloadSpeed, setDownloadSpeed] = useState<number>(0);
    const lastDownloadProgressRef = React.useRef<{ bytes: number; time: number } | null>(null);

    // Ref for access in event listener
    const bucketRef = React.useRef(initialBucket);
    const pathRef = React.useRef(currentPath);

    // Keep refs in sync with state
    useEffect(() => {
        bucketRef.current = initialBucket;
    }, [initialBucket]);

    useEffect(() => {
        pathRef.current = currentPath;
    }, [currentPath]);

    // Context Menu State
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, visible: boolean, file?: FileObject } | null>(null);

    // Multi-select State
    const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
    const lastSelectedIndexRef = React.useRef<number | null>(null);

    // Drag & Drop State (external files from OS)
    const [isDragOver, setIsDragOver] = useState(false);

    // Internal drag & drop state (moving files within app)
    const [draggedFiles, setDraggedFiles] = useState<string[]>([]);
    const draggedFilesRef = useRef<string[]>([]); // Ref for immediate access during drag events
    const [dropTargetFolder, setDropTargetFolder] = useState<string | null>(null);
    // Counter-based approach to fix dragenter/dragleave firing on nested elements
    const dragEnterCounterRef = useRef<Map<string, number>>(new Map());

    // Wrapper to update both state and ref
    const updateDraggedFiles = (files: string[]) => {
        draggedFilesRef.current = files;
        setDraggedFiles(files);
    };

    // Reset drag counters (call on drop or drag end)
    const resetDragCounters = () => {
        dragEnterCounterRef.current.clear();
        setDropTargetFolder(null);
    };

    // Handle drag enter with counter
    const handleDragEnterFolder = (folderKey: string) => {
        const counter = dragEnterCounterRef.current.get(folderKey) || 0;
        dragEnterCounterRef.current.set(folderKey, counter + 1);
        if (counter === 0) {
            setDropTargetFolder(folderKey);
        }
    };

    // Handle drag leave with counter
    const handleDragLeaveFolder = (folderKey: string) => {
        const counter = dragEnterCounterRef.current.get(folderKey) || 0;
        if (counter > 0) {
            dragEnterCounterRef.current.set(folderKey, counter - 1);
            if (counter - 1 === 0) {
                setDropTargetFolder(null);
            }
        }
    };

    // Trash State
    const [isTrashView, setIsTrashView] = useState(false);
    const [trashCount, setTrashCount] = useState(0);

    // New Folder Dialog State
    const [showNewFolderDialog, setShowNewFolderDialog] = useState(false);
    const [newFolderName, setNewFolderName] = useState("");
    const [showRenameDialog, setShowRenameDialog] = useState(false);
    const [renameTarget, setRenameTarget] = useState<FileObject | null>(null);
    const [renameName, setRenameName] = useState("");
    const [newFolderAtRoot, setNewFolderAtRoot] = useState(false);

    // Move To Dialog State
    const [showMoveDialog, setShowMoveDialog] = useState(false);
    const [moveTargets, setMoveTargets] = useState<string[]>([]);
    const [movingStatus, setMovingStatus] = useState<string | null>(null); // Shows "Moving to X..." banner

    // View Mode State: 'list' or 'column'
    type ViewMode = 'list' | 'column';
    const [viewMode, setViewMode] = useState<ViewMode>('list');

    // Search State
    const [searchQuery, setSearchQuery] = useState<string>("");

    // Sort State
    type SortField = 'name' | 'date' | 'size';
    type SortOrder = 'asc' | 'desc';
    const [sortField, setSortField] = useState<SortField>('name');
    const [sortOrder, setSortOrder] = useState<SortOrder>('asc');

    const handleSort = (field: SortField) => {
        if (sortField === field) {
            // Toggle order if same field
            setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
        } else {
            // New field, default to ascending (except date defaults to desc/newest first)
            setSortField(field);
            setSortOrder(field === 'date' ? 'desc' : 'asc');
        }
    };

    // Make window resizable when FileBrowser is shown
    useEffect(() => {
        const appWindow = getCurrentWindow();
        appWindow.setResizable(true).catch(console.error);
    }, []);

    // Ref to batch progress updates (reduces re-renders)
    const pendingProgressRef = React.useRef<Record<string, UploadProgress>>({});
    const progressUpdateScheduledRef = React.useRef(false);
    // Track per-file byte counts to detect actual transfers (not restarts)
    const lastFileBytesRef = React.useRef<Record<string, number>>({});

    // Listen for upload progress events and calculate speed
    useEffect(() => {
        const unlisten = listen<UploadProgress>("upload-progress", (event) => {
            const progress = event.payload;

            // Calculate actual bytes transferred for this update (not total)
            const lastBytes = lastFileBytesRef.current[progress.filename] || 0;
            const bytesTransferred = Math.max(0, progress.bytes_uploaded - lastBytes);
            lastFileBytesRef.current[progress.filename] = progress.bytes_uploaded;

            // Accumulate bytes and calculate speed over fixed time window
            if (bytesTransferred > 0) {
                const now = Date.now();
                const accum = uploadBytesAccumRef.current;

                // Reset accumulator every 2 seconds for fresh readings
                if (accum.startTime === 0 || now - accum.startTime > 2000) {
                    uploadBytesAccumRef.current = { bytes: bytesTransferred, startTime: now, lastUpdate: now };
                } else {
                    accum.bytes += bytesTransferred;
                    accum.lastUpdate = now;

                    // Calculate speed after at least 1 second of data
                    const duration = (now - accum.startTime) / 1000;
                    if (duration >= 1.0) {
                        const speed = accum.bytes / duration;
                        // Cap at 2 Gbit/s (250 MB/s) - reasonable max for most connections
                        const maxSpeed = 250 * 1024 * 1024;
                        setUploadSpeed(Math.min(speed, maxSpeed));
                    }
                }
            }

            // Store in pending ref (doesn't trigger re-render)
            pendingProgressRef.current[progress.filename] = progress;

            // Schedule a batched update if not already scheduled
            if (!progressUpdateScheduledRef.current) {
                progressUpdateScheduledRef.current = true;

                // Use requestAnimationFrame to batch updates and avoid blocking UI
                requestAnimationFrame(() => {
                    progressUpdateScheduledRef.current = false;
                    const pending = { ...pendingProgressRef.current };

                    setUploadProgressMap(prev => {
                        const newMap = { ...prev, ...pending };
                        return newMap;
                    });

                    // Clean up completed uploads
                    Object.entries(pending).forEach(([filename, prog]) => {
                        if (prog.percent >= 100) {
                            setTimeout(() => {
                                delete pendingProgressRef.current[filename];
                                delete lastFileBytesRef.current[filename];
                                setUploadProgressMap(prev => {
                                    const newMap = { ...prev };
                                    delete newMap[filename];
                                    // Reset speed if no more uploads
                                    if (Object.keys(newMap).length === 0) {
                                        setUploadSpeed(0);
                                        uploadBytesAccumRef.current = { bytes: 0, startTime: 0, lastUpdate: 0 };
                                    }
                                    return newMap;
                                });
                            }, 1000);
                        }
                    });
                });
            }
        });
        return () => { unlisten.then(f => f()); };
    }, []);

    // Listen for download progress events
    useEffect(() => {
        const unlisten = listen<DownloadProgress>("download-progress", (event) => {
            const progress = event.payload;
            setDownloadProgress(progress);

            // Calculate download speed
            const now = Date.now();
            const last = lastDownloadProgressRef.current;

            if (last && progress.bytes_downloaded > last.bytes) {
                const timeDiff = (now - last.time) / 1000; // seconds
                const bytesDiff = progress.bytes_downloaded - last.bytes;
                if (timeDiff > 0) {
                    const speed = bytesDiff / timeDiff;
                    setDownloadSpeed(speed);
                }
            }

            lastDownloadProgressRef.current = { bytes: progress.bytes_downloaded, time: now };

            // Clean up when complete
            if (progress.percent >= 100) {
                setTimeout(() => {
                    setDownloadProgress(null);
                    setDownloadSpeed(0);
                    lastDownloadProgressRef.current = null;
                }, 2000);
            }
        });
        return () => { unlisten.then(f => f()); };
    }, []);

    // Initial load of root folders and trash count
    useEffect(() => {
        loadRootFolders(true); // Auto-select default folder on initial load
        loadTrashCount();
    }, []);

    // Sync bucket - only when not in trash view
    useEffect(() => {
        if (initialBucket && !isTrashView) {
            loadFiles(initialBucket, currentPath);
        }
    }, [initialBucket, currentPath, isTrashView]);

    const loadRootFolders = async (autoSelect: boolean = false) => {
        try {
            const result = await invoke<ListResult>("list_objects_cached", {
                bucket: initialBucket,
                prefix: "",
                forceRefresh: false
            });
            // Filter only directories, exclude .Trash
            const folders = result.files
                .filter(f => f.is_dir && !f.key.startsWith('.Trash'))
                .map(f => f.key.slice(0, -1)); // Remove trailing slash
            setRootFolders(folders);

            // Auto-select a default folder on initial load
            if (autoSelect && folders.length > 0 && !currentPath) {
                // Prefer "Documents" if it exists, otherwise use first folder
                const defaultFolder = folders.includes('Documents') ? 'Documents' : folders[0];
                setCurrentPath(defaultFolder + '/');
            }
        } catch (err) {
            console.error("Failed to load root folders", err);
            // Fallback to non-cached if cache not ready
            try {
                const list = await invoke<FileObject[]>("list_objects", { bucket: initialBucket, prefix: "" });
                const folders = list
                    .filter(f => f.is_dir && !f.key.startsWith('.Trash'))
                    .map(f => f.key.slice(0, -1));
                setRootFolders(folders);
                if (autoSelect && folders.length > 0 && !currentPath) {
                    const defaultFolder = folders.includes('Documents') ? 'Documents' : folders[0];
                    setCurrentPath(defaultFolder + '/');
                }
            } catch (fallbackErr) {
                console.error("Fallback also failed:", fallbackErr);
            }
        }
    };

    // Storage stats loading state
    const [storageLoading, setStorageLoading] = useState(false);
    const storageStatsCache = React.useRef<{ stats: StorageStats | null; timestamp: number }>({ stats: null, timestamp: 0 });

    // Load storage stats in background - cached for 5 minutes
    useEffect(() => {
        const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
        const now = Date.now();

        // Skip if we have recent cached data
        if (storageStatsCache.current.stats && now - storageStatsCache.current.timestamp < CACHE_DURATION) {
            setStorageStats(storageStatsCache.current.stats);
            return;
        }

        // Load in background without blocking UI
        const loadInBackground = async () => {
            setStorageLoading(true);
            try {
                const stats = await invoke<StorageStats>("get_storage_stats", { bucket: initialBucket });
                setStorageStats(stats);
                storageStatsCache.current = { stats, timestamp: Date.now() };
            } catch (err) {
                console.error("Failed to load storage stats:", err);
            } finally {
                setStorageLoading(false);
            }
        };

        // Delay storage stats loading so it doesn't compete with file listing
        const timeoutId = setTimeout(loadInBackground, 2000);
        return () => clearTimeout(timeoutId);
    }, [initialBucket]);

    // Listen for refresh events
    useEffect(() => {
        const handleRefresh = () => {
            loadFiles(initialBucket, pathRef.current, true); // Force refresh
            loadRootFolders(); // Also reload sidebar
        };
        window.addEventListener('refresh-files', handleRefresh);
        return () => window.removeEventListener('refresh-files', handleRefresh);
    }, [initialBucket]);

    // Listen for cache-updated events from background refresh
    useEffect(() => {
        let unlisten: (() => void) | undefined;

        const setupListener = async () => {
            unlisten = await listen<{ bucket: string; prefix: string; item_count: number }>(
                'cache-updated',
                (event) => {
                    // Only update if this event is for our current path
                    if (event.payload.prefix === pathRef.current) {
                        setIsRefreshing(false);
                        // Reload to get the fresh cached data
                        loadFiles(initialBucket, pathRef.current);
                    }
                }
            );
        };

        setupListener();
        return () => unlisten?.();
    }, [initialBucket]);

    // Tauri v2 Drag & Drop handler - adds files to queue
    useEffect(() => {
        let unlisten: (() => void) | undefined;

        const setupDragDrop = async () => {
            const appWindow = getCurrentWindow();
            unlisten = await appWindow.onDragDropEvent((event) => {
                if (event.payload.type === 'over') {
                    setIsDragOver(true);
                } else if (event.payload.type === 'leave') {
                    setIsDragOver(false);
                } else if (event.payload.type === 'drop') {
                    setIsDragOver(false);
                    const paths = event.payload.paths;
                    if (!paths || paths.length === 0) return;

                    // Reset speed calculation when adding new items
                    uploadBytesAccumRef.current = { bytes: 0, startTime: 0, lastUpdate: 0 };
                    lastFileBytesRef.current = {};
                    setUploadSpeed(0);

                    // Add files to queue (with deduplication)
                    const currentFolder = pathRef.current;
                    const folderName = currentFolder.split('/').filter(Boolean).pop() || 'Root';

                    let addedCount = 0;
                    setUploadQueue(prev => {
                        const existingPaths = new Set(prev.map(item => item.filePath));
                        const newItems: QueuedUpload[] = paths
                            .filter(path => !existingPaths.has(path)) // Skip duplicates
                            .map((path) => {
                                const fileName = path.split(/[/\\]/).pop() || 'unknown';
                                return {
                                    id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
                                    filePath: path,
                                    fileName,
                                    targetKey: currentFolder + fileName,
                                    targetFolder: currentFolder,
                                    status: 'pending' as const
                                };
                            });
                        addedCount = newItems.length;
                        return [...prev, ...newItems];
                    });

                    // Show feedback for dropped files
                    if (addedCount > 0) {
                        const message = addedCount === 1
                            ? `Queued 1 file for upload to ${folderName}`
                            : `Queued ${addedCount} files for upload to ${folderName}`;
                        setSuccessMessage(message);
                        setTimeout(() => setSuccessMessage(null), 3000);
                    }
                }
            });
        };

        setupDragDrop();
        return () => { if (unlisten) unlisten(); };
    }, []);

    // Queue processor - uploads up to MAX_CONCURRENT files simultaneously
    const MAX_CONCURRENT = 3;

    useEffect(() => {
        // Count currently uploading items
        const uploadingItems = uploadQueue.filter(item => item.status === 'uploading');
        const uploadingCount = uploadingItems.length;

        // Check how many slots are available
        const availableSlots = MAX_CONCURRENT - uploadingCount;
        if (availableSlots <= 0) return; // All slots full

        // Find pending items to start
        const pendingItems = uploadQueue.filter(item => item.status === 'pending');
        if (pendingItems.length === 0) {
            // No pending items - clear UI if queue is empty or all done
            if (uploadingCount === 0 && (uploadQueue.length === 0 || uploadQueue.every(item =>
                item.status === 'complete' || item.status === 'paused' || item.status === 'error'
            ))) {
                setUploading(false);
                setUploadProgressMap({});
                setUploadSpeed(0);
                uploadBytesAccumRef.current = { bytes: 0, startTime: 0, lastUpdate: 0 };
                lastFileBytesRef.current = {};
            }
            return;
        }

        // Start uploads for available slots
        const itemsToStart = pendingItems.slice(0, availableSlots);

        // Process each item
        const processItem = async (pendingItem: QueuedUpload) => {
            setUploading(true);

            // Mark as uploading
            setUploadQueue(prev => prev.map(item =>
                item.id === pendingItem.id ? { ...item, status: 'uploading' as const } : item
            ));

            try {
                await invoke("upload_file", {
                    bucket: bucketRef.current,
                    filePath: pendingItem.filePath,
                    targetKey: pendingItem.targetKey
                });

                // Mark as complete
                setUploadQueue(prev => prev.map(item =>
                    item.id === pendingItem.id ? { ...item, status: 'complete' as const, retryCount: 0 } : item
                ));

                // Remove completed item after short delay
                setTimeout(() => {
                    setUploadQueue(prev => prev.filter(item => item.id !== pendingItem.id));
                }, 500);

                window.dispatchEvent(new CustomEvent('refresh-files'));

            } catch (e: any) {
                console.error("Upload failed:", e);
                const errorMessage = e.toString();

                // Check if upload was cancelled by user (skip) - don't retry, just leave paused
                if (errorMessage.includes("Upload cancelled")) {
                    console.log("Upload was skipped by user");
                    // The skipCurrentUpload function already set it to paused, just return
                    return;
                }

                const currentRetries = pendingItem.retryCount || 0;

                if (currentRetries < MAX_RETRIES) {
                    // Retry with exponential backoff - use setTimeout to avoid race condition
                    const delay = RETRY_DELAY_MS * Math.pow(2, currentRetries);
                    console.log(`Retrying upload in ${delay}ms (attempt ${currentRetries + 1}/${MAX_RETRIES})`);

                    // Set to a temporary 'retrying' state, then back to pending after delay
                    setUploadQueue(prev => prev.map(item =>
                        item.id === pendingItem.id ? {
                            ...item,
                            status: 'paused' as const, // Temporarily paused during retry delay
                            retryCount: currentRetries + 1,
                            lastError: errorMessage
                        } : item
                    ));

                    // Schedule retry after delay
                    setTimeout(() => {
                        setUploadQueue(prev => prev.map(item =>
                            item.id === pendingItem.id && item.status === 'paused' ? {
                                ...item,
                                status: 'pending' as const
                            } : item
                        ));
                    }, delay);
                } else {
                    // Max retries reached, mark as error
                    setUploadQueue(prev => prev.map(item =>
                        item.id === pendingItem.id ? {
                            ...item,
                            status: 'error' as const,
                            lastError: errorMessage
                        } : item
                    ));
                }
            }
        };

        // Start all items that fit in available slots
        itemsToStart.forEach(item => processItem(item));
    }, [uploadQueue]); // Re-run whenever queue changes

    const loadFiles = async (bucket: string, prefix: string, forceRefresh: boolean = false) => {
        // Only show full loading spinner on first load (not from cache)
        if (!isFromCache) {
            setLoading(true);
        }
        setLoadingTooLong(false);
        setError(null);

        // Set timeout to show "taking too long" message after 10 seconds
        const timeoutId = setTimeout(() => {
            setLoadingTooLong(true);
        }, 10000);

        try {
            const result = await invoke<ListResult>("list_objects_cached", {
                bucket,
                prefix,
                forceRefresh
            });

            setFiles(result.files.sort((a, b) => {
                if (a.is_dir && !b.is_dir) return -1;
                if (!a.is_dir && b.is_dir) return 1;
                return a.key.localeCompare(b.key);
            }));

            setIsFromCache(result.from_cache);

            // If data came from stale cache, show refreshing indicator
            if (result.from_cache && !result.cache_status.is_fresh) {
                setIsRefreshing(true);
            }
        } catch (err: any) {
            const errorMsg = err.toString();
            if (errorMsg.includes("Not connected")) {
                setError("Not connected to server. Please restart the app and try again.");
            } else if (errorMsg.includes("timeout") || errorMsg.includes("Timeout")) {
                setError("Connection timed out. The server may be slow or unreachable.");
            } else if (errorMsg.includes("network") || errorMsg.includes("Network")) {
                setError("Network error. Please check your internet connection.");
            } else if (errorMsg.includes("Database not initialized")) {
                // Cache not ready - fall back to regular list
                console.log("Cache not ready, using non-cached list");
                try {
                    const list = await invoke<FileObject[]>("list_objects", { bucket, prefix });
                    setFiles(list.sort((a, b) => {
                        if (a.is_dir && !b.is_dir) return -1;
                        if (!a.is_dir && b.is_dir) return 1;
                        return a.key.localeCompare(b.key);
                    }));
                    setIsFromCache(false);
                } catch (fallbackErr: any) {
                    setError("Failed to load files: " + fallbackErr.toString());
                }
            } else {
                setError("Failed to load files: " + errorMsg);
            }
        } finally {
            clearTimeout(timeoutId);
            setLoading(false);
            setLoadingTooLong(false);
        }
    };

    // Format bytes to human readable
    const formatBytes = (bytes: number): string => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    const openNewFolderDialog = (atRoot: boolean = false) => {
        setNewFolderAtRoot(atRoot);
        setNewFolderName("");
        setShowNewFolderDialog(true);
    };

    const handleCreateFolder = async () => {
        if (!newFolderName.trim()) return;

        const cleanName = newFolderName.trim();

        // If creating at root, path is just "Name"
        // If creating in current path (e.g. "Docs/"), path is "Docs/Name"
        let targetPath = cleanName;
        if (!newFolderAtRoot && currentPath) {
            targetPath = currentPath + cleanName;
        }

        try {
            await invoke("create_s3_folder", { bucket: initialBucket, path: targetPath });

            // Refresh folders list
            await loadRootFolders();

            if (newFolderAtRoot) {
                // Navigate to the new root folder
                setCurrentPath(cleanName + "/");
            } else {
                // Refresh current view
                loadFiles(initialBucket, currentPath);
            }

            setShowNewFolderDialog(false);
            setNewFolderName("");
        } catch (err: any) {
            setError("Failed to create folder: " + err.toString());
        }
    };

    const openRenameDialog = (file: FileObject) => {
        const fileName = file.key.split('/').filter(Boolean).pop() || '';
        setRenameTarget(file);
        setRenameName(fileName);
        setShowRenameDialog(true);
    };

    const handleRename = async () => {
        if (!renameTarget || !renameName.trim()) return;

        try {
            await invoke("rename_object", {
                bucket: initialBucket,
                oldKey: renameTarget.key,
                newName: renameName.trim()
            });

            setShowRenameDialog(false);
            setRenameTarget(null);
            setRenameName("");

            // Invalidate cache and refresh files
            await invoke("invalidate_cache", { bucket: initialBucket, prefix: currentPath });
            loadFiles(initialBucket, currentPath);
            loadRootFolders();

            setSuccessMessage(`Renamed to "${renameName.trim()}"`);
            setTimeout(() => setSuccessMessage(null), 3000);
        } catch (err: any) {
            setError("Failed to rename: " + err.toString());
        }
    };

    // Open the Move To dialog with selected files
    const openMoveDialog = () => {
        // Don't open if a move is already in progress
        if (movingStatus) {
            setError("Please wait for the current move to complete");
            setTimeout(() => setError(null), 3000);
            return;
        }
        const targets = selectedFiles.size > 0
            ? Array.from(selectedFiles)
            : [];
        if (targets.length === 0) return;
        setMoveTargets(targets);
        setShowMoveDialog(true);
    };

    // Handle moving files to a destination folder (background operation)
    const handleMoveTo = async (destinationFolder: string) => {
        if (moveTargets.length === 0 || movingStatus) return;

        const targets = [...moveTargets];
        const folderName = destinationFolder.split('/').filter(Boolean).pop() || 'Root';
        const fileCount = targets.length;

        // Close dialog immediately
        setShowMoveDialog(false);
        setMoveTargets([]);

        // Show status banner
        setMovingStatus(`Moving ${fileCount} ${fileCount === 1 ? 'item' : 'items'} to ${folderName}...`);

        try {
            await handleMoveFiles(targets, destinationFolder);
            // Invalidate cache for source and destination folders
            await invoke("invalidate_cache", { bucket: initialBucket, prefix: currentPath });
            await invoke("invalidate_cache", { bucket: initialBucket, prefix: destinationFolder });
            // Refresh the file list
            loadFiles(initialBucket, currentPath);
            // Show success message
            setSuccessMessage(`Moved ${fileCount} ${fileCount === 1 ? 'item' : 'items'} to ${folderName}`);
            setTimeout(() => setSuccessMessage(null), 3000);
        } catch (err: any) {
            setError("Move failed: " + err.toString());
        } finally {
            setMovingStatus(null);
        }
    };

    const handleContextMenu = (e: React.MouseEvent) => {
        e.preventDefault();
        setContextMenu({ x: e.clientX, y: e.clientY, visible: true });
    };

    const handleDownload = async (e: React.MouseEvent, file: FileObject) => {
        e.stopPropagation();
        e.preventDefault();

        const fileName = file.key.split('/').filter(Boolean).pop() || file.key;
        const defaultName = file.is_dir ? `${fileName}.zip` : fileName;

        // Show save dialog
        const selectedPath = await save({
            defaultPath: defaultName,
            title: `Save ${file.is_dir ? 'folder as ZIP' : 'file'}`,
        });

        // User cancelled the dialog
        if (!selectedPath) {
            return;
        }

        setSuccessMessage(`Downloading ${fileName}...`);

        try {
            let savedPath: string;
            if (file.is_dir) {
                // Download folder as zip
                savedPath = await invoke<string>("download_folder", {
                    bucket: initialBucket,
                    prefix: file.key,
                    savePath: selectedPath
                });
            } else {
                // Download single file
                savedPath = await invoke<string>("download_file", {
                    bucket: initialBucket,
                    key: file.key,
                    savePath: selectedPath
                });
            }
            setSuccessMessage(`Downloaded to: ${savedPath}`);
            // Clear success message after 5 seconds
            setTimeout(() => setSuccessMessage(null), 5000);
        } catch (err: any) {
            console.error("Download error:", err);
            setError("Download failed: " + err.toString());
        }
    };

    const handleDelete = async (e: React.MouseEvent, file: FileObject) => {
        e.stopPropagation();
        const fileName = file.key.split('/').filter(Boolean).pop() || file.key;

        if (isTrashView) {
            // Permanently delete from trash
            if (!confirm(`Permanently delete "${fileName}"? This cannot be undone.`)) return;
            try {
                await invoke("delete_object", {
                    bucket: initialBucket,
                    key: file.key
                });
                loadTrash();
            } catch (err: any) {
                alert("Delete failed: " + err.toString());
            }
        } else {
            // Move to trash
            try {
                await invoke("move_to_trash", {
                    bucket: initialBucket,
                    key: file.key
                });
                loadFiles(initialBucket, currentPath);
                loadTrashCount();
            } catch (err: any) {
                alert("Move to trash failed: " + err.toString());
            }
        }
    };

    // Bulk delete handler
    const handleBulkDelete = async () => {
        if (selectedFiles.size === 0) return;

        const count = selectedFiles.size;
        const message = isTrashView
            ? `Permanently delete ${count} item${count > 1 ? 's' : ''}? This cannot be undone.`
            : `Move ${count} item${count > 1 ? 's' : ''} to trash?`;

        if (!confirm(message)) return;

        try {
            let successCount = 0;
            for (const key of selectedFiles) {
                try {
                    if (isTrashView) {
                        await invoke("delete_object", { bucket: initialBucket, key });
                    } else {
                        await invoke("move_to_trash", { bucket: initialBucket, key });
                    }
                    successCount++;
                } catch (err) {
                    console.error(`Failed to delete ${key}:`, err);
                }
            }

            setSelectedFiles(new Set());
            if (isTrashView) {
                loadTrash();
            } else {
                loadFiles(initialBucket, currentPath);
                loadTrashCount();
            }

            if (successCount === count) {
                setSuccessMessage(`${isTrashView ? 'Deleted' : 'Moved to trash'}: ${count} item${count > 1 ? 's' : ''}`);
            } else {
                setError(`${isTrashView ? 'Deleted' : 'Moved'} ${successCount} of ${count} items`);
            }
            setTimeout(() => setSuccessMessage(null), 3000);
        } catch (err: any) {
            setError("Bulk delete failed: " + err.toString());
        }
    };

    // Bulk download handler
    const handleBulkDownload = async () => {
        if (selectedFiles.size === 0) return;

        // Get the selected file objects
        const selectedFileObjects = files.filter(f => selectedFiles.has(f.key));

        if (selectedFileObjects.length === 1) {
            // Single file - use regular download
            handleDownload({ stopPropagation: () => {}, preventDefault: () => {} } as any, selectedFileObjects[0]);
            return;
        }

        // Multiple files - pick a destination folder
        const selectedFolder = await open({
            directory: true,
            multiple: false,
            title: `Choose folder to download ${selectedFileObjects.length} files`,
        });

        if (!selectedFolder) return;

        setSuccessMessage(`Downloading ${selectedFileObjects.length} files...`);

        try {
            const keys = selectedFileObjects.map(f => f.key);
            const result = await invoke<string>("download_files_to_folder", {
                bucket: initialBucket,
                keys,
                folderPath: selectedFolder
            });
            setSuccessMessage(result);
            setSelectedFiles(new Set());
            setTimeout(() => setSuccessMessage(null), 5000);
        } catch (err: any) {
            console.error("Bulk download error:", err);
            setError("Bulk download failed: " + err.toString());
        }
    };

    // Handle moving files to a folder
    const handleMoveFiles = async (keys: string[], targetFolder: string) => {
        if (keys.length === 0) return;

        try {
            const movedCount = await invoke<number>("move_files", {
                bucket: initialBucket,
                keys,
                targetFolder
            });

            setSelectedFiles(new Set());
            updateDraggedFiles([]);
            loadFiles(initialBucket, currentPath);

            const folderName = targetFolder.split('/').filter(Boolean).pop() || 'root';
            setSuccessMessage(`Moved ${movedCount} file${movedCount > 1 ? 's' : ''} to ${folderName}`);
            setTimeout(() => setSuccessMessage(null), 3000);
        } catch (err: any) {
            console.error("Move error:", err);
            setError("Move failed: " + err.toString());
        }
    };

    const loadTrash = async () => {
        setLoading(true);
        try {
            const list = await invoke<FileObject[]>("list_objects", { bucket: initialBucket, prefix: ".Trash/" });
            // Filter out the .Trash/ folder itself
            const trashFiles = list.filter(f => f.key !== ".Trash/" && !f.is_dir);
            setFiles(trashFiles);
            setTrashCount(trashFiles.length);
        } catch (err: any) {
            setError("Failed to load trash: " + err.toString());
        } finally {
            setLoading(false);
        }
    };

    const loadTrashCount = async () => {
        try {
            const list = await invoke<FileObject[]>("list_objects", { bucket: initialBucket, prefix: ".Trash/" });
            const count = list.filter(f => f.key !== ".Trash/" && !f.is_dir).length;
            setTrashCount(count);
        } catch {
            // Silently fail
        }
    };

    const handleEmptyTrash = async () => {
        if (trashCount === 0) return;
        if (!confirm(`Permanently delete ${trashCount} item${trashCount > 1 ? 's' : ''} from Trash? This cannot be undone.`)) return;

        try {
            const deleted = await invoke<number>("empty_trash", { bucket: initialBucket });
            setTrashCount(0);
            if (isTrashView) {
                setFiles([]);
            }
            alert(`Deleted ${deleted} item${deleted > 1 ? 's' : ''} from Trash.`);
        } catch (err: any) {
            alert("Failed to empty trash: " + err.toString());
        }
    };

    const openTrash = () => {
        setIsTrashView(true);
        setCurrentPath("");
        loadTrash();
    };

    const exitTrash = () => {
        setIsTrashView(false);
        setCurrentPath("");
        loadFiles(initialBucket, "");
    };

    const formatSize = (bytes: number) => {
        if (bytes === 0) return "--";
        const k = 1024;
        const sizes = ["B", "KB", "MB", "GB", "TB"];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
    };

    const formatDate = (dateStr: string) => {
        if (!dateStr || dateStr.trim() === "") return "—";
        try {
            const d = new Date(dateStr);
            if (isNaN(d.getTime())) return "—";
            return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) +
                " at " + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
        } catch {
            return "—";
        }
    };

    const formatSpeed = (bytesPerSec: number) => {
        if (bytesPerSec === 0) return null;
        // Convert bytes to bits (×8) then to megabits
        const mbitsPerSec = (bytesPerSec * 8) / (1000 * 1000);
        if (mbitsPerSec < 1) {
            // Show Kbit/s for slow speeds
            const kbitsPerSec = (bytesPerSec * 8) / 1000;
            return kbitsPerSec.toFixed(0) + " Kbit/s";
        }
        return mbitsPerSec.toFixed(1) + " Mbit/s";
    };

    // Multi-select click handler
    const handleFileClick = (e: React.MouseEvent, file: FileObject, index: number, visibleFiles: FileObject[]) => {
        const isMacBundle = /\.(app|framework|bundle|plugin|kext)$/i.test(file.key);
        const displayAsFolder = file.is_dir && !isMacBundle && !isTrashView;

        // If clicking a folder, navigate into it (unless multi-selecting)
        if (displayAsFolder && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
            navigateToFolder(file.key);
            setSelectedFiles(new Set());
            lastSelectedIndexRef.current = null;
            return;
        }

        const isMetaKey = e.metaKey || e.ctrlKey; // Cmd on Mac, Ctrl on Windows

        if (e.shiftKey && lastSelectedIndexRef.current !== null) {
            // Shift+Click: select range
            const start = Math.min(lastSelectedIndexRef.current, index);
            const end = Math.max(lastSelectedIndexRef.current, index);
            const rangeKeys = visibleFiles.slice(start, end + 1).map(f => f.key);

            if (isMetaKey) {
                // Shift+Cmd: add range to existing selection
                setSelectedFiles(prev => {
                    const newSet = new Set(prev);
                    rangeKeys.forEach(key => newSet.add(key));
                    return newSet;
                });
            } else {
                // Shift only: replace selection with range
                setSelectedFiles(new Set(rangeKeys));
            }
        } else if (isMetaKey) {
            // Cmd/Ctrl+Click: toggle individual item
            setSelectedFiles(prev => {
                const newSet = new Set(prev);
                if (newSet.has(file.key)) {
                    newSet.delete(file.key);
                } else {
                    newSet.add(file.key);
                }
                return newSet;
            });
            lastSelectedIndexRef.current = index;
        } else {
            // Normal click: select only this item
            setSelectedFiles(new Set([file.key]));
            lastSelectedIndexRef.current = index;
        }
    };

    // Clear selection and search when path changes
    useEffect(() => {
        setSelectedFiles(new Set());
        lastSelectedIndexRef.current = null;
        setSearchQuery("");
    }, [currentPath, isTrashView]);

    // Queue control handlers
    const pauseQueueItem = (id: string) => {
        setUploadQueue(prev => prev.map(item =>
            item.id === id && item.status === 'pending' ? { ...item, status: 'paused' as const } : item
        ));
    };

    const resumeQueueItem = (id: string) => {
        setUploadQueue(prev => prev.map(item =>
            item.id === id && item.status === 'paused' ? { ...item, status: 'pending' as const } : item
        ));
    };

    const removeFromQueue = (id: string) => {
        setUploadQueue(prev => prev.filter(item => item.id !== id));
    };

    const retryQueueItem = (id: string) => {
        setUploadQueue(prev => prev.map(item =>
            item.id === id && item.status === 'error' ? {
                ...item,
                status: 'pending' as const,
                retryCount: 0,
                lastError: undefined
            } : item
        ));
    };

    const skipCurrentUpload = async (id: string) => {
        try {
            // Signal backend to cancel current upload
            await invoke("cancel_current_upload");
            // Move item to paused state (the backend will return an error which we'll handle)
            setUploadQueue(prev => prev.map(item =>
                item.id === id && item.status === 'uploading' ? {
                    ...item,
                    status: 'paused' as const,
                    retryCount: 0 // Reset retry count so they get fresh retries when resumed
                } : item
            ));
        } catch (e) {
            console.error("Failed to skip upload:", e);
        }
    };

    // Navigate to a folder - uses flushSync to ensure immediate UI update during uploads
    const navigateToFolder = useCallback((path: string) => {
        flushSync(() => {
            setIsTrashView(false);
            setCurrentPath(path);
        });
    }, []);

    // Navigate to parent folder
    const goBack = () => {
        if (!currentPath) return; // Already at root
        // Remove trailing slash, split, remove last segment, rejoin
        const parts = currentPath.replace(/\/$/, '').split('/');
        parts.pop();
        const parentPath = parts.length > 0 ? parts.join('/') + '/' : '';
        navigateToFolder(parentPath);
    };

    // Get current folder name for display
    const getCurrentFolderName = () => {
        if (!currentPath) return 'Root';
        const parts = currentPath.replace(/\/$/, '').split('/');
        return parts[parts.length - 1] || 'Root';
    };

    return (
        <div className="flex h-screen bg-white text-gray-900 overflow-hidden font-sans">
            {/* Sidebar */}
            <div className="w-64 bg-gray-50/80 backdrop-blur-xl border-r border-gray-200 flex flex-col pt-5">
                <div className="px-5 pb-5">
                    <img src="/mosaic.png" alt="Mosaic" className="h-8 w-auto object-contain" />
                </div>

                <div className="mx-5 border-b border-gray-200 mb-4"></div>

                <div className="px-4 mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Root Folders</span>
                </div>

                <div className="flex-1 overflow-y-auto px-3 space-y-0.5">
                    {rootFolders.map((folderName) => {
                        const fullPath = folderName + "/";
                        const isActive = !isTrashView && currentPath === fullPath;
                        const isSidebarDropTarget = dropTargetFolder === fullPath;
                        return (
                            <button
                                key={folderName}
                                onClick={() => navigateToFolder(fullPath)}
                                onDragOver={(e) => {
                                    if (draggedFilesRef.current.length > 0) {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        e.dataTransfer.dropEffect = 'move';
                                    }
                                }}
                                onDragEnter={(e) => {
                                    if (draggedFilesRef.current.length > 0) {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        handleDragEnterFolder(fullPath);
                                    }
                                }}
                                onDragLeave={(e) => {
                                    if (draggedFilesRef.current.length > 0) {
                                        e.stopPropagation();
                                        handleDragLeaveFolder(fullPath);
                                    }
                                }}
                                onDrop={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    if (draggedFilesRef.current.length > 0) {
                                        handleMoveFiles(draggedFilesRef.current, fullPath);
                                    }
                                    updateDraggedFiles([]);
                                    resetDragCounters();
                                }}
                                className={cn(
                                    "w-full text-left px-3 py-2 rounded-md flex items-center gap-3 text-[13px] font-medium transition-colors",
                                    isActive && !isSidebarDropTarget
                                        ? "bg-blue-100/50 text-blue-600"
                                        : !isSidebarDropTarget && "text-gray-600 hover:bg-gray-100 hover:text-gray-900",
                                    isSidebarDropTarget && "!bg-green-200 ring-2 ring-green-500 text-green-800"
                                )}
                            >
                                <Folder className={cn("w-4 h-4 fill-current", isSidebarDropTarget ? "text-green-600" : isActive ? "text-blue-500" : "text-gray-400")} />
                                <span className="truncate">{folderName}</span>
                            </button>
                        );
                    })}

                    <button
                        onClick={() => openNewFolderDialog(true)}
                        className="w-full text-left px-3 py-2 rounded-md flex items-center gap-3 text-[13px] font-medium text-gray-400 hover:text-gray-600 hover:bg-gray-50 transition-colors mt-2"
                    >
                        <Plus className="w-4 h-4" />
                        <span>Add Root Folder</span>
                    </button>
                </div>

                {/* Trash */}
                <div className="px-3 py-2 border-t border-gray-200">
                    <button
                        onClick={openTrash}
                        className={cn(
                            "w-full text-left px-3 py-2 rounded-md flex items-center gap-3 text-[13px] font-medium transition-colors",
                            isTrashView
                                ? "bg-red-50 text-red-600"
                                : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                        )}
                    >
                        <Trash className={cn("w-4 h-4", isTrashView ? "text-red-500" : "text-gray-400")} />
                        <span>Trash</span>
                        {trashCount > 0 && (
                            <span className="ml-auto text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full">
                                {trashCount}
                            </span>
                        )}
                    </button>
                </div>

                {/* Connection Status */}
                <div className="p-4 border-t border-gray-200 bg-gray-50/50 text-xs text-gray-400">
                    Connected to <span className="font-semibold text-gray-600">{initialBucket}</span>
                </div>
            </div>

            {/* Main Content */}
            <div className="flex-1 flex flex-col min-w-0 bg-white overflow-hidden">
                {/* Header / Navigation */}
                <div className="h-14 border-b border-gray-100 flex items-center px-4 justify-between sticky top-0 bg-white/80 backdrop-blur-md z-10 shrink-0">
                    <div className="flex items-center gap-3 text-sm">
                        {/* Back button */}
                        <button
                            onClick={isTrashView ? exitTrash : goBack}
                            disabled={!isTrashView && !currentPath}
                            className={cn(
                                "p-1.5 rounded-md transition-colors",
                                (isTrashView || currentPath)
                                    ? "hover:bg-gray-100 text-gray-600 hover:text-gray-900"
                                    : "text-gray-300 cursor-not-allowed"
                            )}
                            title={isTrashView ? "Exit Trash" : "Go back"}
                        >
                            <ChevronLeft className="w-5 h-5" />
                        </button>

                        {/* Current folder/trash name */}
                        <div className="flex items-center gap-2">
                            {isTrashView ? (
                                <>
                                    <Trash className="w-4 h-4 text-red-500" />
                                    <span className="font-semibold text-red-600">Trash</span>
                                    {trashCount > 0 && (
                                        <span className="text-xs text-gray-400">({trashCount} items)</span>
                                    )}
                                </>
                            ) : (
                                <>
                                    <Folder className={cn("w-4 h-4", currentPath ? "text-blue-500" : "text-gray-400")} />
                                    <span className="font-semibold text-gray-800">{getCurrentFolderName()}</span>
                                </>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-3">
                        {/* Empty Trash button - only in trash view */}
                        {isTrashView && trashCount > 0 && (
                            <button
                                onClick={handleEmptyTrash}
                                className="px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 rounded-md transition-colors"
                            >
                                Empty Trash
                            </button>
                        )}


                        {/* View Mode Toggle */}
                        <div className="flex items-center bg-gray-100 rounded-lg p-0.5">
                            <button
                                onClick={() => setViewMode('list')}
                                className={cn(
                                    "p-1.5 rounded-md transition-colors",
                                    viewMode === 'list'
                                        ? "bg-white shadow-sm text-gray-700"
                                        : "text-gray-400 hover:text-gray-600"
                                )}
                                title="List view"
                            >
                                <List className="w-4 h-4" />
                            </button>
                            <button
                                onClick={() => setViewMode('column')}
                                className={cn(
                                    "p-1.5 rounded-md transition-colors",
                                    viewMode === 'column'
                                        ? "bg-white shadow-sm text-gray-700"
                                        : "text-gray-400 hover:text-gray-600"
                                )}
                                title="Column view"
                            >
                                <Columns className="w-4 h-4" />
                            </button>
                        </div>

                        <div className="w-64 relative">
                            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                            <input
                                type="text"
                                placeholder="Search files..."
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="w-full pl-9 pr-8 py-1.5 bg-gray-100 border-transparent focus:bg-white focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 rounded-md text-sm transition-all outline-none"
                            />
                            {searchQuery && (
                                <button
                                    onClick={() => setSearchQuery("")}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            )}
                        </div>
                    </div>
                </div>

                {/* File List - Finder Style */}
                <div
                    className="flex-1 overflow-y-auto overflow-x-hidden relative"
                    onContextMenu={handleContextMenu}
                >
                    {/* Drop Zone Overlay - only show in list view for external uploads, not internal moves */}
                    {isDragOver && viewMode === 'list' && draggedFiles.length === 0 && (
                        <div className="absolute inset-0 z-50 bg-blue-500/10 border-2 border-dashed border-blue-500 rounded-lg m-4 flex items-center justify-center pointer-events-none">
                            <div className="text-center">
                                <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-blue-100 flex items-center justify-center">
                                    <Plus className="w-8 h-8 text-blue-600" />
                                </div>
                                <p className="text-blue-600 font-semibold text-lg">Drop files or folders here</p>
                                <p className="text-blue-500/70 text-sm mt-1">Files will be uploaded to {currentPath || "root"}</p>
                            </div>
                        </div>
                    )}
                    {error && (
                        <div className="m-4 p-4 bg-red-50 border border-red-200 rounded-lg text-sm">
                            <div className="flex justify-between items-start gap-4">
                                <div className="flex-1">
                                    <div className="font-semibold text-red-700 mb-1">Error</div>
                                    <div className="text-red-600 break-words">{error}</div>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                    <button
                                        onClick={() => {
                                            navigator.clipboard.writeText(`Mosaic Drive Error:\n${error}\n\nTime: ${new Date().toISOString()}\nBucket: ${initialBucket}\nPath: ${currentPath}`);
                                            setSuccessMessage("Error copied to clipboard");
                                            setTimeout(() => setSuccessMessage(null), 2000);
                                        }}
                                        className="px-2 py-1 text-xs bg-red-100 hover:bg-red-200 text-red-700 rounded transition-colors"
                                        title="Copy error details"
                                    >
                                        Copy
                                    </button>
                                    <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 text-lg leading-none">×</button>
                                </div>
                            </div>
                        </div>
                    )}
                    {successMessage && (
                        <div className="m-4 p-4 bg-green-50 border border-green-100 rounded-lg text-green-600 text-sm flex justify-between items-center">
                            <span>{successMessage}</span>
                            <button onClick={() => setSuccessMessage(null)} className="text-green-400 hover:text-green-600">✕</button>
                        </div>
                    )}
                    {movingStatus && (
                        <div className="m-4 p-4 bg-indigo-50 border border-indigo-200 rounded-lg text-sm flex items-center gap-3">
                            <Loader2 className="w-4 h-4 text-indigo-600 animate-spin" />
                            <span className="text-indigo-700">{movingStatus}</span>
                        </div>
                    )}

                    {/* Filter out .keep files and .Trash in normal view, apply search and sorting */}
                    {(() => {
                        const visibleFiles = files.filter(file => {
                            const fileName = file.key.split('/').filter(Boolean).pop() || '';
                            // Hide .keep files (used to maintain empty folders)
                            if (fileName === '.keep' || fileName === '.gitkeep') return false;
                            // Hide .Trash folder in normal view (shown in sidebar)
                            if (!isTrashView && file.key.startsWith('.Trash')) return false;
                            // Apply search filter
                            if (searchQuery) {
                                const query = searchQuery.toLowerCase();
                                const nameToSearch = fileName.toLowerCase();
                                if (!nameToSearch.includes(query)) return false;
                            }
                            return true;
                        }).sort((a, b) => {
                            // Folders always first
                            if (a.is_dir && !b.is_dir) return -1;
                            if (!a.is_dir && b.is_dir) return 1;

                            let comparison = 0;
                            const aName = a.key.split('/').filter(Boolean).pop() || '';
                            const bName = b.key.split('/').filter(Boolean).pop() || '';

                            switch (sortField) {
                                case 'name':
                                    comparison = aName.localeCompare(bName);
                                    break;
                                case 'date':
                                    const aDate = a.last_modified ? new Date(a.last_modified).getTime() : 0;
                                    const bDate = b.last_modified ? new Date(b.last_modified).getTime() : 0;
                                    comparison = aDate - bDate;
                                    break;
                                case 'size':
                                    comparison = a.size - b.size;
                                    break;
                            }

                            return sortOrder === 'asc' ? comparison : -comparison;
                        });

                        return viewMode === 'list' ? (
                    <div className="w-full">
                        {/* List Header */}
                        <div className="sticky top-0 bg-gray-50 border-b border-gray-100 px-6 py-2 grid grid-cols-12 gap-4 text-xs font-medium text-gray-500 uppercase tracking-wider">
                            <button
                                onClick={() => handleSort('name')}
                                className="col-span-6 flex items-center gap-1 hover:text-gray-700 transition-colors text-left"
                            >
                                Name
                                {sortField === 'name' && (
                                    sortOrder === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
                                )}
                            </button>
                            <button
                                onClick={() => handleSort('date')}
                                className="col-span-3 flex items-center gap-1 hover:text-gray-700 transition-colors text-left"
                            >
                                Date Modified
                                {sortField === 'date' && (
                                    sortOrder === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
                                )}
                            </button>
                            <button
                                onClick={() => handleSort('size')}
                                className="col-span-3 flex items-center gap-1 hover:text-gray-700 transition-colors text-left"
                            >
                                Size
                                {sortField === 'size' && (
                                    sortOrder === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />
                                )}
                            </button>
                        </div>

                        {loading ? (
                            <div className="px-6 py-12 flex flex-col items-center justify-center gap-3">
                                <Loader2 className="w-6 h-6 text-blue-500 animate-spin" />
                                {loadingTooLong && (
                                    <div className="text-center">
                                        <p className="text-gray-500 text-sm">Taking longer than expected...</p>
                                        <p className="text-gray-400 text-xs mt-1">The server may be slow or there may be a connection issue.</p>
                                        <button
                                            onClick={() => loadFiles(initialBucket, currentPath)}
                                            className="mt-3 px-3 py-1.5 text-xs bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-md transition-colors"
                                        >
                                            Retry
                                        </button>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="divide-y divide-gray-50">
                                {/* Upload Queue - optimized to only show relevant items */}
                                {(() => {
                                    // Categorize queue items
                                    const uploadingItems = uploadQueue.filter(q => q.status === 'uploading');
                                    const errorItems = uploadQueue.filter(q => q.status === 'error');
                                    const pausedItems = uploadQueue.filter(q => q.status === 'paused');
                                    const pendingItems = uploadQueue.filter(q => q.status === 'pending');

                                    // Calculate overall progress
                                    const totalItems = uploadQueue.length;
                                    const activeItems = uploadingItems.length + pendingItems.length + pausedItems.length + errorItems.length;

                                    // Show: all uploading, all errors, all paused, and up to 5 pending
                                    const MAX_PENDING_SHOWN = 5;
                                    const visiblePending = pendingItems.slice(0, MAX_PENDING_SHOWN);
                                    const hiddenPendingCount = Math.max(0, pendingItems.length - MAX_PENDING_SHOWN);

                                    const itemsToShow = [...uploadingItems, ...errorItems, ...pausedItems, ...visiblePending];

                                    return (
                                        <>
                                            {/* Overall upload progress summary */}
                                            {totalItems > 1 && activeItems > 0 && (
                                                <div className="px-4 py-2 bg-blue-50 border-b border-blue-100 flex items-center justify-between">
                                                    <div className="flex items-center gap-2">
                                                        <Upload className="w-4 h-4 text-blue-600" />
                                                        <span className="text-sm font-medium text-blue-700">
                                                            Uploading {uploadingItems.length} of {activeItems} files
                                                        </span>
                                                    </div>
                                                    <span className="text-xs text-blue-600">
                                                        {pendingItems.length > 0 && `${pendingItems.length} queued`}
                                                        {pausedItems.length > 0 && ` · ${pausedItems.length} paused`}
                                                        {errorItems.length > 0 && ` · ${errorItems.length} failed`}
                                                    </span>
                                                </div>
                                            )}
                                            {itemsToShow.map((item) => {
                                                const itemTargetFolder = item.targetFolder || '';
                                                const isForDifferentFolder = itemTargetFolder !== currentPath;
                                                const folderName = itemTargetFolder.split('/').filter(Boolean).pop() || 'Root';
                                                const isCurrentlyUploading = item.status === 'uploading';
                                                const isPending = item.status === 'pending';
                                                const isPaused = item.status === 'paused';
                                                const isError = item.status === 'error';
                                                const hasRetries = (item.retryCount || 0) > 0;
                                                const totalPending = pendingItems.length;
                                                const itemProgress = uploadProgressMap[item.fileName];

                                                return (
                                                    <div
                                                        key={item.id}
                                                        className={cn(
                                                            "group relative grid grid-cols-12 gap-4 px-4 py-0.5 items-center text-sm overflow-hidden",
                                                            isCurrentlyUploading ? "bg-blue-50/50" :
                                                            isPaused ? "bg-orange-50/50" :
                                                            isError ? "bg-red-50/50" : "bg-gray-50/50"
                                                        )}
                                                    >
                                                        {isCurrentlyUploading && itemProgress && (
                                                            <div
                                                                className="absolute inset-0 bg-blue-100/50 transition-all duration-300"
                                                                style={{ width: `${itemProgress.percent}%` }}
                                                            />
                                                        )}
                                                        <div className="col-span-5 flex items-center gap-2 overflow-hidden relative z-10">
                                                            {isCurrentlyUploading ? (
                                                                <Upload className="w-4 h-4 text-blue-500 animate-pulse flex-shrink-0" />
                                                            ) : isPaused ? (
                                                                <Pause className="w-4 h-4 text-orange-500 flex-shrink-0" />
                                                            ) : isError ? (
                                                                <X className="w-4 h-4 text-red-500 flex-shrink-0" />
                                                            ) : (
                                                                <Loader2 className="w-4 h-4 text-gray-400 animate-spin flex-shrink-0" />
                                                            )}
                                                            <span className={cn(
                                                                "truncate font-medium",
                                                                isCurrentlyUploading ? "text-blue-700" :
                                                                isPaused ? "text-orange-600" :
                                                                isError ? "text-red-600" : "text-gray-500"
                                                            )}>
                                                                {item.fileName}
                                                                {isForDifferentFolder && (
                                                                    <span className="text-gray-400 font-normal ml-1">→ {folderName}</span>
                                                                )}
                                                            </span>
                                                        </div>
                                                        <div className={cn(
                                                            "col-span-3 text-xs relative z-10",
                                                            isCurrentlyUploading ? "text-blue-600" :
                                                            isPaused ? "text-orange-500" :
                                                            isError ? "text-red-500" : "text-gray-400"
                                                        )}>
                                                            {isCurrentlyUploading
                                                                ? (itemProgress?.total_files ?? 0) > 1
                                                                    ? `File ${itemProgress?.current_file} of ${itemProgress?.total_files}`
                                                                    : "Uploading..."
                                                                : isPaused
                                                                    ? hasRetries
                                                                        ? `Retrying in ${Math.pow(2, (item.retryCount || 1) - 1) * 2}s...`
                                                                        : "Paused"
                                                                    : isError
                                                                        ? "Failed"
                                                                        : hasRetries
                                                                            ? `Retry ${item.retryCount}/${MAX_RETRIES}`
                                                                            : `Queued (${totalPending} total)`
                                                            }
                                                        </div>
                                                        <div className={cn(
                                                            "col-span-2 text-xs font-semibold relative z-10 text-right",
                                                            isCurrentlyUploading ? "text-blue-600" :
                                                            isPaused ? "text-orange-500" :
                                                            isError ? "text-red-500" : "text-gray-400"
                                                        )}>
                                                            {isCurrentlyUploading
                                                                ? `${itemProgress?.percent ?? 0}%`
                                                                : isPaused
                                                                    ? "—"
                                                                    : isError
                                                                        ? "Error"
                                                                        : "Waiting..."
                                                            }
                                                        </div>
                                                        <div className="col-span-2 flex items-center justify-end gap-1 relative z-10">
                                                            {isCurrentlyUploading && (
                                                                <button
                                                                    onClick={() => skipCurrentUpload(item.id)}
                                                                    className="p-1 hover:bg-white/50 rounded text-blue-400 hover:text-orange-500 transition-colors"
                                                                    title="Skip (pause this upload)"
                                                                >
                                                                    <Pause className="w-3.5 h-3.5" />
                                                                </button>
                                                            )}
                                                            {isPending && (
                                                                <button
                                                                    onClick={() => pauseQueueItem(item.id)}
                                                                    className="p-1 hover:bg-white/50 rounded text-gray-400 hover:text-orange-500 transition-colors"
                                                                    title="Pause"
                                                                >
                                                                    <Pause className="w-3.5 h-3.5" />
                                                                </button>
                                                            )}
                                                            {isPaused && (
                                                                <button
                                                                    onClick={() => resumeQueueItem(item.id)}
                                                                    className="p-1 hover:bg-white/50 rounded text-gray-400 hover:text-green-500 transition-colors"
                                                                    title="Resume"
                                                                >
                                                                    <Play className="w-3.5 h-3.5" />
                                                                </button>
                                                            )}
                                                            {isError && (
                                                                <button
                                                                    onClick={() => retryQueueItem(item.id)}
                                                                    className="p-1 hover:bg-white/50 rounded text-gray-400 hover:text-blue-500 transition-colors"
                                                                    title="Retry"
                                                                >
                                                                    <Play className="w-3.5 h-3.5" />
                                                                </button>
                                                            )}
                                                            {!isCurrentlyUploading && (
                                                                <button
                                                                    onClick={() => removeFromQueue(item.id)}
                                                                    className="p-1 hover:bg-white/50 rounded text-gray-400 hover:text-red-500 transition-colors"
                                                                    title="Remove"
                                                                >
                                                                    <X className="w-3.5 h-3.5" />
                                                                </button>
                                                            )}
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                            {/* Show summary of hidden pending items */}
                                            {hiddenPendingCount > 0 && (
                                                <div className="px-4 py-1 text-xs text-gray-400 bg-gray-50/50">
                                                    <span className="flex items-center gap-2">
                                                        <Loader2 className="w-3 h-3 animate-spin" />
                                                        +{hiddenPendingCount} more files queued
                                                    </span>
                                                </div>
                                            )}
                                        </>
                                    );
                                })()}
                                {/* Download Progress - matches upload queue styling */}
                                {downloadProgress && (
                                    <div
                                        className="group relative grid grid-cols-12 gap-4 px-4 py-0.5 items-center text-sm overflow-hidden bg-green-50/50"
                                    >
                                        {/* Progress bar background */}
                                        <div
                                            className="absolute inset-0 bg-green-100/50 transition-all duration-300"
                                            style={{ width: `${downloadProgress.percent}%` }}
                                        />
                                        <div className="col-span-5 flex items-center gap-2 overflow-hidden relative z-10">
                                            <Download className="w-4 h-4 text-green-500 animate-pulse flex-shrink-0" />
                                            <span className="truncate font-medium text-green-700">
                                                {downloadProgress.filename}
                                            </span>
                                        </div>
                                        <div className="col-span-3 text-xs relative z-10 text-green-600">
                                            {downloadProgress.total_files > 1
                                                ? `File ${downloadProgress.current_file} of ${downloadProgress.total_files}`
                                                : "Downloading..."}
                                        </div>
                                        <div className="col-span-2 text-xs font-semibold relative z-10 text-right text-green-600">
                                            {downloadProgress.percent}%
                                        </div>
                                        <div className="col-span-2 flex items-center justify-end gap-1 relative z-10">
                                            <ArrowDown className="w-3 h-3 text-green-500" />
                                            <span className="text-xs text-green-600 font-medium">
                                                {formatSpeed(downloadSpeed) || "—"}
                                            </span>
                                        </div>
                                    </div>
                                )}
                                {visibleFiles.length === 0 && !uploading && !downloadProgress ? (
                                    <div className="px-6 py-12 text-center text-gray-400 text-sm flex flex-col items-center gap-2">
                                        {searchQuery ? (
                                            <>
                                                <Search className="w-8 h-8 text-gray-300 mb-2" />
                                                <p>No files match "{searchQuery}"</p>
                                                <button
                                                    onClick={() => setSearchQuery("")}
                                                    className="text-xs text-blue-500 hover:text-blue-600"
                                                >
                                                    Clear search
                                                </button>
                                            </>
                                        ) : isTrashView ? (
                                            <>
                                                <Trash className="w-8 h-8 text-gray-300 mb-2" />
                                                <p>Trash is empty</p>
                                            </>
                                        ) : (
                                            <>
                                                <p>Folder is empty</p>
                                                <p className="text-xs text-gray-300">Drop files to upload</p>
                                            </>
                                        )}
                                    </div>
                                ) : (
                                    visibleFiles.map((file, index) => {
                                        // Get display name
                                        let fileName = file.key.split('/').filter(Boolean).pop() || '';

                                        // In trash view, remove timestamp prefix (format: timestamp_filename)
                                        if (isTrashView && fileName.includes('_')) {
                                            const underscoreIndex = fileName.indexOf('_');
                                            const possibleTimestamp = fileName.substring(0, underscoreIndex);
                                            // Check if it looks like a timestamp (all digits, reasonable length)
                                            if (/^\d{13,}$/.test(possibleTimestamp)) {
                                                fileName = fileName.substring(underscoreIndex + 1);
                                            }
                                        }

                                        // Treat macOS bundles (.app, .framework, .bundle) as files, not folders
                                        const isMacBundle = /\.(app|framework|bundle|plugin|kext)$/i.test(fileName);
                                        const displayAsFolder = file.is_dir && !isMacBundle && !isTrashView;
                                        const isSelected = selectedFiles.has(file.key);

                                        const isDragTarget = displayAsFolder && dropTargetFolder === file.key;
                                        const isBeingDragged = draggedFiles.includes(file.key);

                                        return (
                                        <div
                                            key={file.key}
                                            draggable={!isTrashView && !displayAsFolder}
                                            onDragStart={(e) => {
                                                if (isTrashView) return;
                                                // If dragging a selected file, drag all selected files
                                                // Otherwise just drag this single file
                                                let filesToDrag: string[];
                                                if (selectedFiles.has(file.key) && selectedFiles.size > 1) {
                                                    filesToDrag = Array.from(selectedFiles);
                                                } else {
                                                    filesToDrag = [file.key];
                                                    // Also select this file if not already selected
                                                    if (!selectedFiles.has(file.key)) {
                                                        setSelectedFiles(new Set([file.key]));
                                                    }
                                                }
                                                updateDraggedFiles(filesToDrag);
                                                e.dataTransfer.effectAllowed = 'move';
                                                // Use custom type to prevent Finder from creating text clippings
                                                e.dataTransfer.setData('application/x-mosaic-files', JSON.stringify(filesToDrag));
                                                // Set drag image to show count
                                                if (filesToDrag.length > 1) {
                                                    const dragLabel = document.createElement('div');
                                                    dragLabel.textContent = `${filesToDrag.length} files`;
                                                    dragLabel.style.cssText = 'position:absolute;top:-1000px;padding:4px 8px;background:#3b82f6;color:white;border-radius:4px;font-size:12px;';
                                                    document.body.appendChild(dragLabel);
                                                    e.dataTransfer.setDragImage(dragLabel, 0, 0);
                                                    setTimeout(() => document.body.removeChild(dragLabel), 0);
                                                }
                                            }}
                                            onDragEnd={() => {
                                                updateDraggedFiles([]);
                                                resetDragCounters();
                                            }}
                                            onDragOver={(e) => {
                                                // Must preventDefault to allow drop
                                                if (displayAsFolder && draggedFilesRef.current.length > 0) {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    e.dataTransfer.dropEffect = 'move';
                                                }
                                            }}
                                            onDragEnter={(e) => {
                                                if (displayAsFolder && draggedFilesRef.current.length > 0) {
                                                    e.preventDefault();
                                                    e.stopPropagation();
                                                    handleDragEnterFolder(file.key);
                                                }
                                            }}
                                            onDragLeave={(e) => {
                                                if (displayAsFolder && draggedFilesRef.current.length > 0) {
                                                    e.stopPropagation();
                                                    handleDragLeaveFolder(file.key);
                                                }
                                            }}
                                            onDrop={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                if (displayAsFolder && draggedFilesRef.current.length > 0) {
                                                    handleMoveFiles(draggedFilesRef.current, file.key);
                                                }
                                                updateDraggedFiles([]);
                                                resetDragCounters();
                                            }}
                                            onClick={(e) => handleFileClick(e, file, index, visibleFiles)}
                                            onDoubleClick={(e) => {
                                                e.preventDefault();
                                                if (!displayAsFolder && !isTrashView) {
                                                    handleDownload(e, file);
                                                }
                                            }}
                                            onContextMenu={(e) => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                // If right-clicking a non-selected file, select it
                                                if (!selectedFiles.has(file.key)) {
                                                    setSelectedFiles(new Set([file.key]));
                                                    lastSelectedIndexRef.current = index;
                                                }
                                                setContextMenu({ x: e.clientX, y: e.clientY, visible: true, file });
                                            }}
                                            className={cn(
                                                "group relative grid grid-cols-12 gap-4 px-4 py-0.5 cursor-pointer transition-colors items-center text-sm select-none",
                                                isSelected && !isDragTarget
                                                    ? "bg-blue-100 hover:bg-blue-150"
                                                    : !isDragTarget && "hover:bg-blue-50/50",
                                                isDragTarget && "!bg-green-200 ring-2 ring-green-500",
                                                isBeingDragged && "opacity-50"
                                            )}
                                        >
                                            <div className="col-span-6 flex items-center gap-2 overflow-hidden">
                                                {displayAsFolder ? (
                                                    <Folder className="w-4 h-4 text-blue-500 fill-blue-500/20 flex-shrink-0" />
                                                ) : (
                                                    <FileIcon className="w-4 h-4 text-gray-400 group-hover:text-gray-500 flex-shrink-0" />
                                                )}
                                                <span className="truncate text-gray-700 font-medium group-hover:text-gray-900">
                                                    {fileName}
                                                </span>
                                            </div>
                                            <div className="col-span-3 text-gray-500 text-xs">
                                                {formatDate(file.last_modified)}
                                            </div>
                                            <div className="col-span-3 text-gray-400 text-xs font-mono">
                                                {formatSize(file.size)}
                                            </div>
                                        </div>
                                    );
                                    })
                                )}
                            </div>
                        )}

                        {/* Context Menu */}
                        {contextMenu && contextMenu.visible && (
                            <>
                                <div
                                    className="fixed inset-0 z-40"
                                    onClick={() => setContextMenu(null)}
                                />
                                <div
                                    className="fixed z-50 bg-white border border-gray-200 shadow-xl rounded-lg py-1 w-48"
                                    style={{ top: contextMenu.y, left: contextMenu.x }}
                                    onClick={(e) => e.stopPropagation()}
                                >
                                    {/* New Folder - always at top */}
                                    <button
                                        onClick={() => { openNewFolderDialog(false); setContextMenu(null); }}
                                        className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
                                    >
                                        <FolderPlus className="w-4 h-4" />
                                        New Folder
                                    </button>
                                    {/* Multi-select actions */}
                                    {selectedFiles.size > 1 && !isTrashView && (
                                        <>
                                            <button
                                                onClick={() => {
                                                    setContextMenu(null);
                                                    openMoveDialog();
                                                }}
                                                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
                                            >
                                                <Folder className="w-4 h-4" />
                                                Move to...
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setContextMenu(null);
                                                    handleBulkDownload();
                                                }}
                                                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
                                            >
                                                <Download className="w-4 h-4" />
                                                Download {selectedFiles.size} files
                                            </button>
                                            <button
                                                onClick={() => {
                                                    setContextMenu(null);
                                                    handleBulkDelete();
                                                }}
                                                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                                Trash {selectedFiles.size} files
                                            </button>
                                        </>
                                    )}
                                    {/* Single file actions */}
                                    {contextMenu.file && selectedFiles.size <= 1 && !isTrashView && (
                                        <>
                                            <button
                                                onClick={() => {
                                                    // Select this file if not already selected
                                                    if (contextMenu.file && !selectedFiles.has(contextMenu.file.key)) {
                                                        setSelectedFiles(new Set([contextMenu.file.key]));
                                                    }
                                                    setContextMenu(null);
                                                    // Small delay to ensure selection is updated
                                                    setTimeout(() => openMoveDialog(), 10);
                                                }}
                                                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
                                            >
                                                <Folder className="w-4 h-4" />
                                                Move to...
                                            </button>
                                            <button
                                                onClick={() => {
                                                    if (contextMenu.file) {
                                                        openRenameDialog(contextMenu.file);
                                                    }
                                                    setContextMenu(null);
                                                }}
                                                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
                                            >
                                                <FileText className="w-4 h-4" />
                                                Rename
                                            </button>
                                            <button
                                                onClick={() => {
                                                    const file = contextMenu.file;
                                                    setContextMenu(null);
                                                    if (file) {
                                                        handleDownload({ stopPropagation: () => {}, preventDefault: () => {} } as any, file);
                                                    }
                                                }}
                                                className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2"
                                            >
                                                <Download className="w-4 h-4" />
                                                {contextMenu.file.is_dir ? "Download as ZIP" : "Download"}
                                            </button>
                                            <button
                                                onClick={() => {
                                                    if (contextMenu.file) {
                                                        handleDelete({ stopPropagation: () => {}, preventDefault: () => {} } as any, contextMenu.file);
                                                    }
                                                    setContextMenu(null);
                                                }}
                                                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 flex items-center gap-2"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                                Move to Trash
                                            </button>
                                        </>
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                        ) : (
                            /* Column View */
                            <ColumnView
                                bucket={initialBucket}
                                initialPath={currentPath}
                                isTrashView={isTrashView}
                                isDragOver={isDragOver}
                                onNavigate={setCurrentPath}
                                onDownload={handleDownload}
                                onDelete={handleDelete}
                                formatDate={formatDate}
                                formatSize={formatSize}
                                draggedFiles={draggedFiles}
                                draggedFilesRef={draggedFilesRef}
                                setDraggedFiles={updateDraggedFiles}
                                dropTargetFolder={dropTargetFolder}
                                onDragEnterFolder={handleDragEnterFolder}
                                onDragLeaveFolder={handleDragLeaveFolder}
                                resetDragCounters={resetDragCounters}
                                onMoveFiles={handleMoveFiles}
                            />
                        );
                    })()}
                </div>

                {/* Status Bar */}
                <div className="h-9 bg-gray-50 border-t border-gray-200 flex items-center px-4 text-[11px] text-gray-500 justify-between font-medium shrink-0">
                    <div className="flex items-center gap-4">
                        <span>{files.length} items</span>
                        {storageLoading ? (
                            <span className="text-gray-400 flex items-center gap-1">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                Calculating...
                            </span>
                        ) : storageStats && (
                            <span className="text-gray-400">
                                {formatBytes(storageStats.used_bytes)}
                                {storageStats.total_bytes > 0 && ` / ${formatBytes(storageStats.total_bytes)}`}
                                {' used'}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-4">
                        {downloadSpeed > 0 && (
                            <div className="flex items-center gap-1.5 text-green-600">
                                <ArrowDown className="w-3 h-3" />
                                <span>{formatSpeed(downloadSpeed)}</span>
                            </div>
                        )}
                        {uploadSpeed > 0 && (
                            <div className="flex items-center gap-1.5 text-blue-600">
                                <ArrowUp className="w-3 h-3" />
                                <span>{formatSpeed(uploadSpeed)}</span>
                            </div>
                        )}
                        <div className="flex items-center gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-green-500"></div>
                            <span>Connected</span>
                        </div>
                    </div>
                </div>
            </div>

            {/* New Folder Dialog */}
            {showNewFolderDialog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center">
                    <div
                        className="absolute inset-0 bg-black/20 backdrop-blur-sm"
                        onClick={() => setShowNewFolderDialog(false)}
                    />
                    <div className="relative bg-white rounded-xl shadow-2xl p-6 w-80">
                        <h3 className="text-lg font-semibold text-gray-900 mb-4">
                            {newFolderAtRoot ? "New Root Folder" : "New Folder"}
                        </h3>
                        <input
                            type="text"
                            value={newFolderName}
                            onChange={(e) => setNewFolderName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') handleCreateFolder();
                                if (e.key === 'Escape') setShowNewFolderDialog(false);
                            }}
                            placeholder="Folder name"
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm"
                            autoFocus
                        />
                        <div className="flex justify-end gap-2 mt-4">
                            <button
                                onClick={() => setShowNewFolderDialog(false)}
                                className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCreateFolder}
                                disabled={!newFolderName.trim()}
                                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Create
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Rename Dialog */}
            {showRenameDialog && renameTarget && (
                <div className="fixed inset-0 z-50 flex items-center justify-center">
                    <div
                        className="absolute inset-0 bg-black/20 backdrop-blur-sm"
                        onClick={() => setShowRenameDialog(false)}
                    />
                    <div className="relative bg-white rounded-xl shadow-2xl p-6 w-80">
                        <h3 className="text-lg font-semibold text-gray-900 mb-4">
                            Rename {renameTarget.is_dir ? "Folder" : "File"}
                        </h3>
                        <input
                            type="text"
                            value={renameName}
                            onChange={(e) => setRenameName(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') handleRename();
                                if (e.key === 'Escape') setShowRenameDialog(false);
                            }}
                            placeholder="New name"
                            className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 text-sm"
                            autoFocus
                            onFocus={(e) => {
                                // Select filename without extension for files
                                if (!renameTarget.is_dir) {
                                    const lastDot = renameName.lastIndexOf('.');
                                    if (lastDot > 0) {
                                        e.target.setSelectionRange(0, lastDot);
                                    } else {
                                        e.target.select();
                                    }
                                } else {
                                    e.target.select();
                                }
                            }}
                        />
                        <div className="flex justify-end gap-2 mt-4">
                            <button
                                onClick={() => setShowRenameDialog(false)}
                                className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleRename}
                                disabled={!renameName.trim()}
                                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Rename
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Move To Dialog */}
            {showMoveDialog && moveTargets.length > 0 && (
                <div className="fixed inset-0 z-50 flex items-center justify-center">
                    <div
                        className="absolute inset-0 bg-black/20 backdrop-blur-sm"
                        onClick={() => !movingStatus && setShowMoveDialog(false)}
                    />
                    <div className="relative bg-white rounded-xl shadow-2xl p-6 w-80 max-h-[70vh] flex flex-col">
                        <h3 className="text-lg font-semibold text-gray-900 mb-2">
                            Move {moveTargets.length === 1 ? "Item" : `${moveTargets.length} Items`}
                        </h3>
                        <p className="text-xs text-gray-500 mb-4">Select destination folder</p>
                        <div className="flex-1 overflow-y-auto space-y-1 min-h-0 max-h-64">
                            {/* Root option */}
                            {currentPath !== "" && (
                                <button
                                    onClick={() => handleMoveTo("")}
                                    disabled={!!movingStatus}
                                    className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    <Folder className="w-4 h-4 text-gray-400" />
                                    <span className="text-gray-500 italic">Root</span>
                                </button>
                            )}
                            {/* Root folders */}
                            {rootFolders.map((folder) => {
                                const folderPath = folder + "/";
                                // Don't show current folder or folders being moved
                                if (folderPath === currentPath) return null;
                                if (moveTargets.some(t => t === folderPath || t.startsWith(folderPath))) return null;
                                return (
                                    <button
                                        key={folder}
                                        onClick={() => handleMoveTo(folderPath)}
                                        disabled={!!movingStatus}
                                        className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                    >
                                        <Folder className="w-4 h-4 text-blue-500 fill-blue-500/20" />
                                        {folder}
                                    </button>
                                );
                            })}
                            {/* Subfolders in current view */}
                            {files
                                .filter(f => f.is_dir && !f.key.startsWith('.Trash'))
                                .filter(f => !moveTargets.includes(f.key))
                                .map((folder) => {
                                    const folderName = folder.key.split('/').filter(Boolean).pop() || folder.key;
                                    // Skip if it's already a root folder
                                    if (rootFolders.includes(folderName) && folder.key === folderName + "/") return null;
                                    return (
                                        <button
                                            key={folder.key}
                                            onClick={() => handleMoveTo(folder.key)}
                                            disabled={!!movingStatus}
                                            className="w-full text-left px-3 py-2 text-sm rounded-lg hover:bg-blue-50 hover:text-blue-600 flex items-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            <Folder className="w-4 h-4 text-blue-500 fill-blue-500/20" />
                                            {currentPath ? `${currentPath}${folderName}` : folderName}
                                        </button>
                                    );
                                })}
                        </div>
                        <div className="flex justify-end gap-2 mt-4 pt-4 border-t border-gray-100">
                            <button
                                onClick={() => setShowMoveDialog(false)}
                                disabled={!!movingStatus}
                                className="px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
