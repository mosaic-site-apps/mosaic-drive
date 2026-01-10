import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { AuthScreen } from "./components/AuthScreen";
import { FileBrowser } from "./components/FileBrowser";

const CREDENTIALS_KEY = 'mosaic-drive-credentials';

interface SavedCredentials {
  accessKey: string;
  secretKey: string;
  endpoint: string;
  bucket: string;
}

interface UpdateInfo {
  version: string;
  currentVersion: string;
}

function App() {
  const [isConnected, setIsConnected] = useState(false);
  const [initialBucket, setInitialBucket] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [updateAvailable, setUpdateAvailable] = useState<UpdateInfo | null>(null);
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateProgress, setUpdateProgress] = useState(0);

  // Check for updates on startup
  useEffect(() => {
    const checkForUpdates = async () => {
      try {
        const update = await check();
        if (update) {
          setUpdateAvailable({
            version: update.version,
            currentVersion: update.currentVersion
          });
        }
      } catch (err) {
        console.log("Update check failed (offline or endpoint not available):", err);
      }
    };
    setTimeout(checkForUpdates, 2000);
  }, []);

  const handleInstallUpdate = async () => {
    setIsUpdating(true);
    try {
      const update = await check();
      if (update) {
        let downloaded = 0;
        let total = 0;
        await update.downloadAndInstall((progress) => {
          if (progress.event === 'Started' && progress.data.contentLength) {
            total = progress.data.contentLength;
          } else if (progress.event === 'Progress') {
            downloaded += progress.data.chunkLength;
            if (total > 0) {
              const percent = Math.round((downloaded / total) * 100);
              setUpdateProgress(percent);
            }
          }
        });
        await relaunch();
      }
    } catch (err) {
      console.error("Update failed:", err);
      setIsUpdating(false);
      setUpdateAvailable(null);
    }
  };

  // Try to auto-connect with saved credentials on startup
  useEffect(() => {
    const tryAutoConnect = async () => {
      try {
        const saved = localStorage.getItem(CREDENTIALS_KEY);
        if (saved) {
          const credentials: SavedCredentials = JSON.parse(saved);
          // Attempt to reconnect
          await invoke("connect", {
            accessKey: credentials.accessKey,
            secretKey: credentials.secretKey,
            endpoint: credentials.endpoint
          });
          setInitialBucket(credentials.bucket);
          setIsConnected(true);
        }
      } catch (err) {
        // Failed to auto-connect, clear saved credentials
        console.error("Auto-connect failed:", err);
        localStorage.removeItem(CREDENTIALS_KEY);
      } finally {
        setIsLoading(false);
      }
    };

    tryAutoConnect();
  }, []);

  const handleConnect = (bucket: string, credentials?: { accessKey: string; secretKey: string; endpoint: string }) => {
    // Save credentials for auto-reconnect
    if (credentials) {
      const toSave: SavedCredentials = {
        ...credentials,
        bucket
      };
      localStorage.setItem(CREDENTIALS_KEY, JSON.stringify(toSave));
    }
    setInitialBucket(bucket);
    setIsConnected(true);
  };

  // Show loading spinner while checking for saved credentials
  if (isLoading) {
    return (
      <div className="h-screen bg-gray-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <img src="/mosaic.png" alt="Mosaic" className="w-16 h-16 animate-pulse" />
          <p className="text-gray-400 text-sm">Connecting...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="text-white selection:bg-blue-500/30">
      {isConnected ? (
        <FileBrowser initialBucket={initialBucket || "demo-bucket"} />
      ) : (
        <AuthScreen onConnect={handleConnect} />
      )}

      {/* Update Available Banner */}
      {updateAvailable && !isUpdating && (
        <div className="fixed top-0 left-0 right-0 z-[100] bg-gradient-to-r from-blue-600 to-blue-500 text-white px-4 py-2 flex items-center justify-center gap-4 shadow-lg">
          <span className="text-sm font-medium">
            Update available: v{updateAvailable.version}
          </span>
          <button
            onClick={handleInstallUpdate}
            className="px-3 py-1 bg-white text-blue-600 rounded-md text-sm font-semibold hover:bg-blue-50 transition-colors"
          >
            Install & Restart
          </button>
          <button
            onClick={() => setUpdateAvailable(null)}
            className="text-white/70 hover:text-white text-lg leading-none"
          >
            ×
          </button>
        </div>
      )}

      {/* Update Progress Overlay */}
      {isUpdating && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-80 text-gray-900">
            <div className="flex items-center gap-3 mb-4">
              <img src="/mosaic.png" alt="Mosaic" className="w-10 h-10" />
              <div>
                <h3 className="font-bold text-lg">Updating...</h3>
                <p className="text-xs text-gray-500">Please wait</p>
              </div>
            </div>
            <div className="space-y-2">
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 transition-all duration-300"
                  style={{ width: `${updateProgress}%` }}
                />
              </div>
              <p className="text-xs text-center text-gray-500">
                {updateProgress > 0 ? `Downloading... ${updateProgress}%` : 'Preparing update...'}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
