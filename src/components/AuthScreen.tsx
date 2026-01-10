import React, { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Key, Lock, ArrowRight, Eye, EyeOff, Image, FileText, Music, Video, Code, FileArchive, Database, Table, Type, Gamepad2, Layers, Cpu, Cloud, Shield } from "lucide-react";
import { cn } from "../lib/cn";

interface AuthScreenProps {
    onConnect: (bucket: string, credentials: { accessKey: string; secretKey: string; endpoint: string }) => void;
}

export function AuthScreen({ onConnect }: AuthScreenProps) {
    const [accessKey, setAccessKey] = useState("");
    const [secretKey, setSecretKey] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    // bucket is now derived from accessKey
    // Replace with your own S3-compatible endpoint
    const [endpoint] = useState("https://s3.mosaic.site");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleConnect = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        const cleanAccessKey = accessKey.trim();
        const cleanSecretKey = secretKey.trim();

        try {
            await invoke("connect", {
                accessKey: cleanAccessKey,
                secretKey: cleanSecretKey,
                endpoint
            });
            // Use cleanAccessKey as the bucket name, pass credentials for persistence
            onConnect(cleanAccessKey, {
                accessKey: cleanAccessKey,
                secretKey: cleanSecretKey,
                endpoint
            });
        } catch (err: any) {
            setError(err.toString());
        } finally {
            setLoading(false);
        }
    };

    const FeatureHex = ({ icon: Icon, label, color, delay }: { icon: any, label: string, color: string, delay: string }) => (
        <div className={`relative w-24 h-28 mx-2 transition-all duration-700 hover:scale-110 group animate-float-${delay}`}>
            {/* Hexagon Shape */}
            <div
                className="absolute inset-0 bg-white/5 backdrop-blur-lg border border-white/10 flex flex-col items-center justify-center gap-2 hover:bg-white/20 transition-all duration-500 overflow-hidden shadow-2xl"
                style={{ clipPath: "polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%)" }}
            >
                {/* Animated Shimmer */}
                <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/10 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-1000 ease-in-out"></div>

                <div className={cn("p-2 rounded-full bg-opacity-20 flex items-center justify-center transition-transform group-hover:scale-110", color)}>
                    <Icon className="w-6 h-6 text-white" />
                </div>
                <span className="text-[9px] font-black text-white/70 uppercase tracking-[0.2em] group-hover:text-white transition-colors">{label}</span>
            </div>
            {/* Glow effect */}
            <div className={cn("absolute inset-0 blur-2xl opacity-0 group-hover:opacity-40 transition-opacity duration-500 -z-10", color.replace('bg-', 'bg-'))}></div>
        </div>
    );

    return (
        <div className="flex h-screen bg-[#f1f5f9] font-sans overflow-hidden">
            {/* Left Column - Form */}
            <div className="w-[450px] p-10 flex flex-col justify-start pt-16 relative z-10 bg-white shadow-[0_0_60px_rgba(0,0,0,0.1)] overflow-y-auto shrink-0">
                <div className="max-w-xs mx-auto w-full space-y-10">
                    <div className="space-y-6 text-center">
                        <div className="flex flex-col items-center gap-6">
                            <div className="relative">
                                <div className="absolute -inset-4 bg-blue-500/10 rounded-full blur-2xl animate-pulse"></div>
                                <img src="/mosaic.png" alt="Mosaic Drive" className="relative w-32 h-32 object-contain drop-shadow-2xl" />
                            </div>
                            <div className="space-y-1">
                                <h1 className="text-4xl font-black tracking-tighter text-gray-900 uppercase">Mosaic Drive</h1>
                                <div className="h-1 w-12 bg-blue-600 mx-auto rounded-full"></div>
                            </div>
                        </div>
                        <p className="text-gray-500 text-sm font-medium leading-relaxed">
                            Connect to your high-performance <br />
                            secure storage environment.
                        </p>
                    </div>

                    <form onSubmit={handleConnect} className="space-y-5">
                        <input type="hidden" value={endpoint} />

                        <div className="space-y-2">
                            <div className="flex items-center justify-between">
                                <label className="text-[11px] font-black text-gray-400 uppercase tracking-widest ml-1">Username</label>
                                {error && (
                                    <span className="text-[11px] font-bold text-red-500 animate-shake mr-4">
                                        Incorrect Credentials
                                    </span>
                                )}
                            </div>
                            <div className="relative group">
                                <Key className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 group-focus-within:text-blue-600 transition-colors" />
                                <input
                                    type="text"
                                    value={accessKey}
                                    onChange={(e) => setAccessKey(e.target.value)}
                                    className={cn(
                                        "w-full bg-gray-50 border rounded-2xl pl-11 pr-4 py-3.5 text-gray-900 shadow-sm focus:bg-white focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all placeholder:text-gray-300 text-sm font-semibold",
                                        error ? "border-red-200 bg-red-50/50" : "border-gray-100"
                                    )}
                                    placeholder="Enter username"
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-[11px] font-black text-gray-400 uppercase tracking-widest ml-1">Password</label>
                            <div className="relative group">
                                <Lock className="w-4 h-4 absolute left-4 top-1/2 -translate-y-1/2 text-gray-300 group-focus-within:text-blue-600 transition-colors" />
                                <input
                                    type={showPassword ? "text" : "password"}
                                    value={secretKey}
                                    onChange={(e) => setSecretKey(e.target.value)}
                                    className={cn(
                                        "w-full bg-gray-50 border rounded-2xl pl-11 pr-12 py-3.5 text-gray-900 shadow-sm focus:bg-white focus:ring-4 focus:ring-blue-500/10 focus:border-blue-500 outline-none transition-all placeholder:text-gray-300 text-sm font-semibold",
                                        error ? "border-red-200 bg-red-50/50" : "border-gray-100"
                                    )}
                                    placeholder="Enter password"
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-300 hover:text-blue-600 transition-colors"
                                >
                                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                                </button>
                            </div>
                        </div>

                        <button
                            type="submit"
                            disabled={loading}
                            className="w-full relative overflow-hidden flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-700 text-white font-black py-4 rounded-2xl transition-all hover:shadow-[0_20px_40px_rgba(37,99,235,0.25)] active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed group"
                        >
                            <span className="relative z-10 uppercase tracking-widest text-[13px]">{loading ? "Establishing Link..." : "Authenticate"}</span>
                            {!loading && <ArrowRight className="w-4 h-4 group-hover:translate-x-1.5 transition-transform relative z-10" />}
                            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:animate-[shimmer_2s_infinite] pointer-events-none"></div>
                        </button>
                    </form>
                </div>

                <div className="mt-auto pt-10 text-center">
                    <div className="inline-flex items-center gap-2 mb-2">
                        <div className="w-1.5 h-1.5 rounded-full bg-blue-600"></div>
                        <span className="text-[10px] font-black text-gray-300 uppercase tracking-[0.3em]">Mosaic Enterprise</span>
                    </div>
                </div>
            </div>

            {/* Right Column - Hero Visual */}
            <div className="flex flex-1 relative bg-[#020617] overflow-hidden items-center justify-center">

                {/* Background Grid Pattern */}
                <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: "radial-gradient(#ffffff 1px, transparent 1px)", backgroundSize: "32px 32px" }}></div>

                {/* Mesh Gradients */}
                <div className="absolute top-0 right-0 w-[1000px] h-[1000px] bg-blue-600/20 rounded-full blur-[160px] -translate-y-1/2 translate-x-1/2"></div>
                <div className="absolute bottom-0 left-1/4 w-[800px] h-[800px] bg-purple-600/15 rounded-full blur-[140px] translate-y-1/2"></div>

                {/* Hexagon Grid */}
                <div className="relative z-10 grid grid-cols-4 gap-y-4 gap-x-1 -rotate-12 scale-100 translate-x-4">
                    {/* Column 1 */}
                    <div className="flex flex-col gap-8 mt-40">
                        <FeatureHex icon={Image} label="Photos" color="bg-blue-500" delay="0" />
                        <FeatureHex icon={Video} label="Videos" color="bg-purple-500" delay="1000" />
                        <FeatureHex icon={Music} label="Music" color="bg-pink-500" delay="2000" />
                    </div>
                    {/* Column 2 */}
                    <div className="flex flex-col gap-8 mt-12">
                        <FeatureHex icon={Cloud} label="Cloud" color="bg-sky-400" delay="500" />
                        <FeatureHex icon={FileText} label="Docs" color="bg-emerald-500" delay="1500" />
                        <FeatureHex icon={Code} label="Code" color="bg-orange-500" delay="2500" />
                        <FeatureHex icon={Layers} label="Assets" color="bg-amber-400" delay="3000" />
                    </div>
                    {/* Column 3 */}
                    <div className="flex flex-col gap-8 mt-48">
                        <FeatureHex icon={Database} label="Data" color="bg-indigo-500" delay="1000" />
                        <FeatureHex icon={Table} label="Sheets" color="bg-green-500" delay="2000" />
                        <FeatureHex icon={Cpu} label="Nodes" color="bg-slate-500" delay="500" />
                        <FeatureHex icon={FileArchive} label="Zip" color="bg-yellow-500" delay="1500" />
                    </div>
                    {/* Column 4 */}
                    <div className="flex flex-col gap-8 mt-24">
                        <FeatureHex icon={Shield} label="Safe" color="bg-rose-500" delay="2000" />
                        <FeatureHex icon={Type} label="Type" color="bg-orange-400" delay="3000" />
                        <FeatureHex icon={Gamepad2} label="Bin" color="bg-violet-500" delay="1000" />
                    </div>
                </div>

            </div>
        </div>
    );
}
