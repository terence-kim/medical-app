using MediSeg.WPF.Helpers;
using MediSeg.WPF.ViewModels;
using Microsoft.Win32;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace MediSeg.WPF
{
    public partial class MainWindow : Window
    {
        private readonly MainViewModel _vm;

        public MainWindow()
        {
            InitializeComponent();
            _vm = new MainViewModel();

            // 컨트롤에 ViewModel 바인딩
            DicomViewer.Bind(_vm);
            MprViewer.Bind(_vm);
            Viewer3D.Bind(_vm);
            MaskPanel.Bind(_vm);
            QuadAxialViewer.Bind(_vm);
            Quad3DViewer.Bind(_vm);

            // Toast 감지
            _vm.PropertyChanged += (s, e) =>
            {
                if (e.PropertyName == nameof(MainViewModel.ToastMessage))
                    Dispatcher.Invoke(UpdateToast);
                if (e.PropertyName == nameof(MainViewModel.HeaderInfo))
                    Dispatcher.Invoke(() => PatientInfoLabel.Text = _vm.HeaderInfo);
                if (e.PropertyName == nameof(MainViewModel.CurrentSliceIndex))
                    Dispatcher.Invoke(() => SyncQuadViews());
            };
        }

        // ── 파일/폴더 열기 ────────────────────────────────────────────
        private async void OpenFolder_Click(object sender, RoutedEventArgs e)
        {
            // .NET 8 WPF 내장 폴더 선택 대화상자
            var dlg = new Microsoft.Win32.OpenFolderDialog
            {
                Title = "DICOM 폴더 선택",
                Multiselect = false
            };
            if (dlg.ShowDialog() == true)
                await _vm.OpenFolderCommand.ExecuteAsync(dlg.FolderName);
        }

        private async void OpenFiles_Click(object sender, RoutedEventArgs e)
        {
            var dlg = new OpenFileDialog
            {
                Title      = "DICOM 파일 선택 (여러 개 가능)",
                Multiselect = true,
                Filter      = "DICOM 파일|*.dcm;*.DCM;*|모든 파일|*.*"
            };
            if (dlg.ShowDialog() == true)
                await _vm.OpenFilesCommand.ExecuteAsync(dlg.FileNames.AsEnumerable());
        }

        // ── 뷰 모드 전환 ──────────────────────────────────────────────
        private async void Mode2D_Click(object sender, RoutedEventArgs e)
        {
            DicomViewer.Visibility  = Visibility.Visible;
            MprViewer.Visibility    = Visibility.Collapsed;
            QuadView.Visibility     = Visibility.Collapsed;
            await _vm.SetViewModeCommand.ExecuteAsync(ViewMode.TwoD);
        }

        private async void ModeMPR_Click(object sender, RoutedEventArgs e)
        {
            DicomViewer.Visibility  = Visibility.Collapsed;
            MprViewer.Visibility    = Visibility.Visible;
            QuadView.Visibility     = Visibility.Collapsed;
            await _vm.SetViewModeCommand.ExecuteAsync(ViewMode.MPR);
        }

        private async void ModeQuad_Click(object sender, RoutedEventArgs e)
        {
            DicomViewer.Visibility  = Visibility.Collapsed;
            MprViewer.Visibility    = Visibility.Collapsed;
            QuadView.Visibility     = Visibility.Visible;
            await _vm.SetViewModeCommand.ExecuteAsync(ViewMode.Quad);
        }

        // ── Quad 뷰 동기화 ────────────────────────────────────────────
        private void SyncQuadViews()
        {
            if (_vm.ViewMode != ViewMode.Quad || _vm.Volume == null) return;
            QuadSagittalImage.Source = DicomRenderHelper.RenderMprSlice(
                _vm.Volume, _vm.VolumeW, _vm.VolumeH, _vm.VolumeD,
                "sagittal", _vm.VolumeW / 2,
                _vm.WindowCenter, _vm.WindowWidth);
            QuadCoronalImage.Source  = DicomRenderHelper.RenderMprSlice(
                _vm.Volume, _vm.VolumeW, _vm.VolumeH, _vm.VolumeD,
                "coronal",  _vm.VolumeH / 2,
                _vm.WindowCenter, _vm.WindowWidth);
        }

        // ── 키보드 단축키 ─────────────────────────────────────────────
        private void Window_KeyDown(object sender, KeyEventArgs e)
        {
            // 텍스트 입력 중 무시
            if (FocusManager.GetFocusedElement(this) is TextBox) return;

            switch (e.Key)
            {
                case Key.B:
                    _vm.BrushMode = BrushMode.Draw;
                    _vm.RefreshTick++;
                    break;
                case Key.E:
                    _vm.BrushMode = BrushMode.Erase;
                    _vm.RefreshTick++;
                    break;
                case Key.H:
                    _vm.SegOverlayOn = !_vm.SegOverlayOn;
                    _vm.RefreshTick++;
                    break;
                case Key.S:
                    _vm.GatePreviewActive = !_vm.GatePreviewActive;
                    _vm.RefreshTick++;
                    break;
                case Key.G:
                    if (!_vm.IsGenerating)
                        _vm.GenerateModelCommand.Execute(null);
                    break;
                case Key.OemQuestion when e.KeyboardDevice.Modifiers == ModifierKeys.None:
                case Key.Oem2:
                    ShortcutsOverlay.Visibility = ShortcutsOverlay.Visibility == Visibility.Visible
                        ? Visibility.Collapsed : Visibility.Visible;
                    break;
                case Key.OemOpenBrackets:
                    _vm.BrushSize = Math.Max(2, _vm.BrushSize - 2);
                    break;
                case Key.OemCloseBrackets:
                    _vm.BrushSize = Math.Min(80, _vm.BrushSize + 2);
                    break;
                case Key.D1: case Key.D2: case Key.D3: case Key.D4:
                case Key.D5: case Key.D6: case Key.D7: case Key.D8:
                    int idx = e.Key - Key.D1;
                    if (idx < _vm.Masks.Count)
                    {
                        _vm.Masks[idx].Visible = !_vm.Masks[idx].Visible;
                        _vm.RefreshTick++;
                    }
                    break;
                case Key.Escape:
                    ShortcutsOverlay.Visibility = Visibility.Collapsed;
                    break;
            }
        }

        // ── 단축키 오버레이 ───────────────────────────────────────────
        private void ShowShortcuts_Click(object sender, RoutedEventArgs e)
            => ShortcutsOverlay.Visibility = Visibility.Visible;

        private void CloseShortcuts_Click(object sender, RoutedEventArgs e)
            => ShortcutsOverlay.Visibility = Visibility.Collapsed;

        private void ShortcutsOverlay_MouseDown(object sender, MouseButtonEventArgs e)
            => ShortcutsOverlay.Visibility = Visibility.Collapsed;

        // ── Toast ─────────────────────────────────────────────────────
        private void UpdateToast()
        {
            if (_vm.ToastMessage == null)
            {
                ToastBorder.Visibility = Visibility.Collapsed;
                return;
            }
            ToastText.Text = _vm.ToastMessage;
            ToastBorder.Visibility = Visibility.Visible;
        }
    }
}
