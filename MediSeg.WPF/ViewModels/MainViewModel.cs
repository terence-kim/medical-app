using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using MediSeg.WPF.Models;
using MediSeg.WPF.Services;
using System.Collections.ObjectModel;
using System.IO;

namespace MediSeg.WPF.ViewModels
{
    public enum ViewMode { TwoD, MPR, Quad }
    public enum BrushMode { Draw, Erase }

    public partial class MainViewModel : ObservableObject
    {
        private readonly DicomLoaderService _dicomLoader;
        private readonly PythonBackendService _pythonService;

        // ── DICOM 데이터 ──────────────────────────────────────────────────
        [ObservableProperty] private List<DicomSlice> _slices = new();
        [ObservableProperty] private int _currentSliceIndex;
        [ObservableProperty] private DicomMetadata? _caseMeta;
        [ObservableProperty] private bool _isLoading;
        [ObservableProperty] private int _loadProgress;
        [ObservableProperty] private string _loadStatus = "";

        // ── 뷰 모드 ───────────────────────────────────────────────────────
        [ObservableProperty] private ViewMode _viewMode = ViewMode.TwoD;

        // ── 마스크 ────────────────────────────────────────────────────────
        [ObservableProperty] private ObservableCollection<Mask> _masks = new(DefaultMasks.Create());
        [ObservableProperty] private string _activeMaskId = "bone";
        [ObservableProperty] private ObservableCollection<string> _selectedMaskIds;

        // ── 브러시 ────────────────────────────────────────────────────────
        [ObservableProperty] private BrushMode _brushMode = BrushMode.Draw;
        [ObservableProperty] private int _brushSize = 12;
        [ObservableProperty] private int _brushHuMin = 400;
        [ObservableProperty] private int _brushHuMax = 3000;
        [ObservableProperty] private bool _gatePreviewActive = true;

        // ── 세그멘테이션 ──────────────────────────────────────────────────
        [ObservableProperty] private byte[]? _labelMap;
        [ObservableProperty] private bool _segOverlayOn = true;
        [ObservableProperty] private bool _isGenerating;
        [ObservableProperty] private double _fillProgress;

        // ── W/L ───────────────────────────────────────────────────────────
        [ObservableProperty] private double _windowCenter = 40;
        [ObservableProperty] private double _windowWidth  = 400;

        // ── Toast ─────────────────────────────────────────────────────────
        [ObservableProperty] private string? _toastMessage;

        // ── 볼륨 (MPR/Quad 용) ────────────────────────────────────────────
        [ObservableProperty] private short[]? _volume;
        [ObservableProperty] private int _volumeW, _volumeH, _volumeD;
        [ObservableProperty] private bool _volumeLoading;
        [ObservableProperty] private int _volumeProgress;

        // ── Trigger (뷰 갱신 신호) ────────────────────────────────────────
        [ObservableProperty] private int _refreshTick;
        [ObservableProperty] private int _generateTick;

        // 캐시된 로드 폴더 경로
        private string? _lastLoadedFolder;

        public DicomSlice? CurrentSlice =>
            Slices.Count > 0 && CurrentSliceIndex < Slices.Count
                ? Slices[CurrentSliceIndex] : null;

        public string HeaderInfo =>
            CaseMeta != null
                ? $"{CaseMeta.PatientName}  ·  {CaseMeta.Modality}  ·  {CaseMeta.StudyDesc}  ·  {Slices.Count} slices"
                : Slices.Count > 0 ? "로딩 중..." : "파일을 불러오세요";

        public bool IsCT =>
            CaseMeta == null || string.IsNullOrEmpty(CaseMeta.Modality) ||
            CaseMeta.Modality is "CT" or "UNKNOWN" or "";

        public MainViewModel()
        {
            _dicomLoader  = new DicomLoaderService();
            _pythonService = new PythonBackendService(
                Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..")));

            _selectedMaskIds = new ObservableCollection<string>(
                DefaultMasks.Create().Where(m => m.Id != "custom").Select(m => m.Id));
        }

        // ── 파일 열기 (파일 목록) ─────────────────────────────────────────
        [RelayCommand]
        public async Task OpenFilesAsync(IEnumerable<string> paths)
        {
            await LoadDicomAsync(paths);
        }

        // ── 폴더 열기 ─────────────────────────────────────────────────────
        [RelayCommand]
        public async Task OpenFolderAsync(string folderPath)
        {
            _lastLoadedFolder = folderPath;
            var files = Directory.GetFiles(folderPath, "*", SearchOption.AllDirectories);
            await LoadDicomAsync(files);
        }

        private async Task LoadDicomAsync(IEnumerable<string> filePaths)
        {
            IsLoading = true;
            LoadProgress = 0;
            LoadStatus = "DICOM 파싱 중...";
            CaseMeta = null;
            Slices = new List<DicomSlice>();
            LabelMap = null;
            Volume = null;

            try
            {
                var progress = new Progress<int>(p =>
                {
                    LoadProgress = p;
                    LoadStatus = $"파싱 중... {p}%";
                });

                var (slices, meta) = await _dicomLoader.LoadAsync(filePaths, progress);
                Slices = slices;
                CaseMeta = meta;
                CurrentSliceIndex = 0;

                // 초기 W/L 설정
                if (slices.Count > 0)
                {
                    WindowCenter = slices[0].WindowCenter;
                    WindowWidth  = slices[0].WindowWidth;
                }

                // LabelMap 초기화 (전체 볼륨 크기)
                LabelMap = new byte[meta.Width * meta.Height * slices.Count];

                LoadStatus = $"로드 완료: {slices.Count} 슬라이스";
                ShowToast($"✅ {meta.PatientName} — {slices.Count}개 슬라이스 로드됨");
                OnPropertyChanged(nameof(HeaderInfo));
                OnPropertyChanged(nameof(IsCT));
                RefreshTick++;
            }
            catch (Exception ex)
            {
                ShowToast($"❌ 로드 실패: {ex.Message}");
                LoadStatus = "로드 실패";
            }
            finally
            {
                IsLoading = false;
            }
        }

        // ── 볼륨 빌드 (MPR/Quad) ─────────────────────────────────────────
        public async Task EnsureVolumeAsync()
        {
            if (Volume != null || Slices.Count == 0) return;
            VolumeLoading = true;
            VolumeProgress = 0;

            await Task.Run(() =>
            {
                int w = Slices[0].Width, h = Slices[0].Height, d = Slices.Count;
                var vol = new short[w * h * d];
                for (int z = 0; z < d; z++)
                {
                    Slices[z].PixelData.CopyTo(vol, z * w * h);
                    VolumeProgress = (z + 1) * 100 / d;
                }
                Volume = vol;
                VolumeW = w; VolumeH = h; VolumeD = d;
            });

            VolumeLoading = false;
        }

        // ── 뷰 모드 변경 ──────────────────────────────────────────────────
        [RelayCommand]
        public async Task SetViewModeAsync(ViewMode mode)
        {
            ViewMode = mode;
            if (mode is ViewMode.MPR or ViewMode.Quad)
                await EnsureVolumeAsync();
        }

        // ── 마스크 활성화 ─────────────────────────────────────────────────
        [RelayCommand]
        public void SetActiveMask(string maskId)
        {
            ActiveMaskId = maskId;
            var m = Masks.FirstOrDefault(x => x.Id == maskId);
            if (m != null) { BrushHuMin = m.HuMin; BrushHuMax = m.HuMax; }
            GatePreviewActive = true;
            RefreshTick++;
        }

        // ── 현재 슬라이스 채우기 ──────────────────────────────────────────
        [RelayCommand]
        public void FillCurrentSlice()
        {
            if (CurrentSlice == null || LabelMap == null) return;
            var activeMask = Masks.FirstOrDefault(m => m.Id == ActiveMaskId);
            if (activeMask == null) return;

            int w = CurrentSlice.Width, h = CurrentSlice.Height;
            int offset = CurrentSliceIndex * w * h;

            for (int i = 0; i < w * h; i++)
            {
                short hu = CurrentSlice.PixelData[i];
                if (hu >= BrushHuMin && hu <= BrushHuMax)
                    LabelMap[offset + i] = activeMask.ColorIndex;
            }
            RefreshTick++;
        }

        // ── 전체 슬라이스 채우기 ──────────────────────────────────────────
        [RelayCommand]
        public async Task FillAllSlicesAsync()
        {
            if (Slices.Count == 0 || LabelMap == null) return;
            var activeMask = Masks.FirstOrDefault(m => m.Id == ActiveMaskId);
            if (activeMask == null) return;

            IsGenerating = true;
            FillProgress = 0;

            await Task.Run(() =>
            {
                for (int z = 0; z < Slices.Count; z++)
                {
                    var s = Slices[z];
                    int offset = z * s.Width * s.Height;
                    for (int i = 0; i < s.PixelData.Length; i++)
                    {
                        short hu = s.PixelData[i];
                        if (hu >= BrushHuMin && hu <= BrushHuMax)
                            LabelMap[offset + i] = activeMask.ColorIndex;
                    }
                    FillProgress = (z + 1.0) / Slices.Count * 100;
                }
            });

            IsGenerating = false;
            FillProgress = 0;
            RefreshTick++;
            ShowToast("✅ 전체 슬라이스 채우기 완료");
        }

        // ── 3D 생성 ───────────────────────────────────────────────────────
        [RelayCommand]
        public void GenerateModel()
        {
            if (LabelMap == null || Slices.Count == 0) return;
            GenerateTick++;
        }

        // ── AI 세그멘테이션 ───────────────────────────────────────────────
        [RelayCommand]
        public async Task RunAISegmentationAsync()
        {
            if (_lastLoadedFolder == null)
            { ShowToast("❌ 먼저 폴더를 불러주세요"); return; }

            IsGenerating = true;
            ShowToast("🤖 AI 세그멘테이션 실행 중...");

            var prog = new Progress<string>(s => LoadStatus = s);
            try
            {
                var niftiPath = await _pythonService.RunSegmentationAsync(_lastLoadedFolder, prog);
                if (niftiPath != null)
                    ShowToast($"✅ AI 세그멘테이션 완료: {Path.GetFileName(niftiPath)}");
                else
                    ShowToast("❌ AI 세그멘테이션 실패 — 로그 확인");
            }
            catch (Exception ex)
            {
                ShowToast($"❌ {ex.Message}");
            }
            finally { IsGenerating = false; }
        }

        // ── Toast ─────────────────────────────────────────────────────────
        private System.Timers.Timer? _toastTimer;
        public void ShowToast(string msg)
        {
            ToastMessage = msg;
            _toastTimer?.Stop();
            _toastTimer = new System.Timers.Timer(3500) { AutoReset = false };
            _toastTimer.Elapsed += (_, _) =>
                System.Windows.Application.Current?.Dispatcher.Invoke(() => ToastMessage = null);
            _toastTimer.Start();
        }
    }
}
