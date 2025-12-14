import { useState, useRef } from 'react'
import VTKViewer from './components/VTKViewer'
import CornerstoneViewer from './components/CornerstoneViewer'
import './App.css'

function App() {
  const [selectedFiles, setSelectedFiles] = useState<File[] | null>(null);
  const [labelMapData, setLabelMapData] = useState<Uint8Array | null>(null);
  const [boneThreshold, setBoneThreshold] = useState(300); // Lifted state
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      console.log(`Selected ${files.length} files`);
      const fileArray = Array.from(files);

      // Log file names for debugging
      fileArray.forEach(f => console.log('File:', f.name, f.type, f.size));

      // Relaxed filter: Allow .dcm, .ima, or files with no extension (common for DICOM)
      // Also exclude known non-image types to avoid clutter
      const candidateFiles = fileArray.filter(f => {
        const name = f.name.toLowerCase();
        return !name.endsWith('.json') && !name.endsWith('.txt') && !name.endsWith('.xml') && !name.endsWith('.ds_store');
      });

      if (candidateFiles.length > 0) {
        console.log(`Passing ${candidateFiles.length} candidate files to viewer`);
        setSelectedFiles(candidateFiles);
        setLabelMapData(null); // Reset labelmap on new file load
      } else {
        alert("No suitable files found in the selected folder.");
      }
    }
  };

  const handleHuSelected = (hu: number) => {
    console.log('HU Selected:', hu);
    // Update threshold if it's a reasonable bone value (or just update it generally)
    // We'll clamp it to the slider range for safety
    const clamped = Math.max(100, Math.min(3000, hu));
    setBoneThreshold(clamped);
  };

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  return (
    <div className="flex h-screen w-full bg-dark-bg text-slate-200 font-sans overflow-hidden">
      {/* Sidebar */}
      <aside className="w-64 border-r border-slate-800 bg-dark-surface flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-slate-800">
          <span className="text-xl font-bold text-primary-500">MediCare</span>
        </div>
        <nav className="flex-1 p-4 space-y-2">
          <NavItem active>Dashboard</NavItem>
          <NavItem>Patients</NavItem>
          <NavItem>Appointments</NavItem>
          <NavItem>Settings</NavItem>
        </nav>
        <div className="p-4 border-t border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-full bg-slate-700 flex items-center justify-center text-xs font-bold">DK</div>
            <div className="text-sm">
              <div className="font-medium">Dr. Kim</div>
              <div className="text-slate-500 text-xs">Cardiology</div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 bg-black">
        {/* Header */}
        <header className="h-14 border-b border-slate-800 bg-dark-bg flex items-center justify-between px-4 shrink-0">
          <h1 className="text-sm font-semibold text-slate-300">Case ID: 2024-001 (Brain MRI)</h1>
          <div className="flex items-center gap-3">
            <div className="text-xs text-slate-500">Last saved: Just now</div>
          </div>
        </header>

        {/* Split View Container */}
        <div className="flex-1 flex flex-row overflow-hidden">
          {/* Left Panel: 2D View */}
          <div className="flex-1 flex flex-col border-r border-slate-700 min-w-0">
            <div className="h-8 bg-slate-900 border-b border-slate-800 flex items-center px-3 justify-between shrink-0">
              <span className="text-xs font-medium text-slate-400">2D View</span>
              <div className="flex gap-2 items-center">
                {/* File Upload Buttons */}
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded transition-colors"
                  title="Open DICOM Folder"
                >
                  Open Folder
                </button>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  // @ts-ignore
                  webkitdirectory=""
                  directory=""
                  multiple
                  className="hidden"
                />

                <button
                  onClick={() => document.getElementById('single-file-input')?.click()}
                  className="text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 px-2 py-0.5 rounded transition-colors"
                  title="Open DICOM Files"
                >
                  Open Files
                </button>
                <input
                  id="single-file-input"
                  type="file"
                  onChange={handleFileChange}
                  multiple
                  className="hidden"
                />
              </div>
            </div>
            <div className="flex-1 bg-black relative flex items-center justify-center overflow-hidden group">
              <CornerstoneViewer
                files={selectedFiles}
                onLabelMapChange={setLabelMapData}
                onHuSelected={handleHuSelected}
              />
            </div>
          </div>

          {/* Right Panel: 3D Volume */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="h-8 bg-slate-900 border-b border-slate-800 flex items-center px-3 justify-between shrink-0">
              <span className="text-xs font-medium text-slate-400">3D Volume</span>
              <div className="flex gap-2">
                {/* Toolbar placeholders */}
                <div className="w-3 h-3 rounded-full bg-slate-700"></div>
                <div className="w-3 h-3 rounded-full bg-slate-700"></div>
              </div>
            </div>
            <div className="flex-1 bg-black relative">
              <VTKViewer
                files={selectedFiles}
                labelMapData={labelMapData}
                boneThreshold={boneThreshold}
                onThresholdChange={setBoneThreshold}
              />
            </div>
            {/* 3D Orientation Cube Placeholder */}
            <div className="absolute bottom-4 right-4 w-12 h-12 border border-slate-700 rounded flex items-center justify-center opacity-50 pointer-events-none">
              <span className="text-[10px] text-slate-500">3D</span>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

function NavItem({ children, active = false }: { children: React.ReactNode; active?: boolean }) {
  return (
    <a
      href="#"
      className={`block px-4 py-2 rounded-md text-sm transition-colors font-medium ${active
        ? 'bg-primary-500/10 text-primary-500'
        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
        }`}
    >
      {children}
    </a>
  )
}



export default App
