using MediSeg.WPF.Helpers;
using MediSeg.WPF.Models;
using MediSeg.WPF.ViewModels;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;

namespace MediSeg.WPF.Controls
{
    public partial class DicomViewerControl : UserControl
    {
        private MainViewModel? _vm;
        private WriteableBitmap? _bitmap;

        // 팬/줌 상태
        private Point _panStart;
        private bool _isPanning;
        private TranslateTransform _translate = new();
        private ScaleTransform _scale = new();

        // W/L 드래그 상태
        private Point _wlStart;
        private bool _isWLDragging;
        private double _wlStartCenter, _wlStartWidth;

        public DicomViewerControl()
        {
            InitializeComponent();
            var tg = new TransformGroup();
            tg.Children.Add(_scale);
            tg.Children.Add(_translate);
            DicomImage.RenderTransform = tg;
            DicomImage.RenderTransformOrigin = new Point(0.5, 0.5);
        }

        // ── VM 연결 ──────────────────────────────────────────────────────
        public void Bind(MainViewModel vm)
        {
            _vm = vm;
            vm.PropertyChanged += (s, e) =>
            {
                switch (e.PropertyName)
                {
                    case nameof(MainViewModel.RefreshTick):
                    case nameof(MainViewModel.CurrentSliceIndex):
                        Dispatcher.Invoke(Refresh);
                        break;
                    case nameof(MainViewModel.IsLoading):
                        Dispatcher.Invoke(UpdateLoadingState);
                        break;
                    case nameof(MainViewModel.LoadProgress):
                        Dispatcher.Invoke(() => LoadBar.Value = vm.LoadProgress);
                        break;
                }
            };
        }

        private void UpdateLoadingState()
        {
            if (_vm == null) return;
            LoadingOverlay.Visibility = _vm.IsLoading ? Visibility.Visible : Visibility.Collapsed;
            EmptyState.Visibility     = (!_vm.IsLoading && _vm.Slices.Count == 0) ? Visibility.Visible : Visibility.Collapsed;
        }

        // ── 화면 갱신 ────────────────────────────────────────────────────
        public void Refresh()
        {
            if (_vm?.CurrentSlice == null) { UpdateLoadingState(); return; }

            EmptyState.Visibility = Visibility.Collapsed;
            var s = _vm.CurrentSlice;

            // 비트맵 재생성이 필요한 경우 (크기 변경)
            if (_bitmap == null || _bitmap.PixelWidth != s.Width || _bitmap.PixelHeight != s.Height)
            {
                _bitmap = new WriteableBitmap(s.Width, s.Height, 96, 96, PixelFormats.Bgr32, null);
                DicomImage.Source = _bitmap;
            }

            // 레이블 색상 배열 구성 (인덱스 0=배경, 1~8=마스크색)
            var labelColors   = BuildLabelColors();
            var visibleLabels = _vm.SegOverlayOn
                ? _vm.Masks.Where(m => m.Visible && _vm.SelectedMaskIds.Contains(m.Id))
                            .Select(m => m.ColorIndex).ToArray()
                : Array.Empty<byte>();

            int sliceOffset = _vm.CurrentSliceIndex * s.Width * s.Height;

            if (_vm.GatePreviewActive && _vm.BrushMode == BrushMode.Draw)
            {
                DicomRenderHelper.ApplyGatePreview(
                    _bitmap, s.PixelData, s.Width, s.Height,
                    _vm.WindowCenter, _vm.WindowWidth,
                    _vm.BrushHuMin, _vm.BrushHuMax);
            }
            else
            {
                DicomRenderHelper.UpdateSlice(
                    _bitmap, s.PixelData, s.Width, s.Height,
                    _vm.WindowCenter, _vm.WindowWidth,
                    _vm.LabelMap, visibleLabels, labelColors, sliceOffset);
            }

            SliceLabel.Text = $"{_vm.CurrentSliceIndex + 1} / {_vm.Slices.Count}";
            WlLabel.Text    = $"W:{(int)_vm.WindowWidth} L:{(int)_vm.WindowCenter}";
        }

        private (byte r, byte g, byte b, byte a)[] BuildLabelColors()
        {
            var arr = new (byte r, byte g, byte b, byte a)[9]; // 0~8
            if (_vm == null) return arr;
            foreach (var m in _vm.Masks)
            {
                if (m.ColorIndex < arr.Length)
                    arr[m.ColorIndex] = (m.Color.R, m.Color.G, m.Color.B, 200);
            }
            return arr;
        }

        // ── 마우스 이벤트 ────────────────────────────────────────────────
        private void Canvas_MouseMove(object sender, MouseEventArgs e)
        {
            if (_vm == null) return;
            var pos = e.GetPosition(OverlayCanvas);
            UpdateBrushCursor(pos);

            // HU 값 표시
            var imgPos = CanvasToImage(pos);
            if (_vm.CurrentSlice != null)
            {
                int px = (int)imgPos.X, py = (int)imgPos.Y;
                var s = _vm.CurrentSlice;
                if (px >= 0 && py >= 0 && px < s.Width && py < s.Height)
                {
                    short hu = s.PixelData[py * s.Width + px];
                    HuLabel.Text = $"HU: {hu}";
                }
            }

            // 브러시 그리기
            if (e.LeftButton == MouseButtonState.Pressed && !_isPanning && !_isWLDragging)
                ApplyBrush(imgPos, _vm.BrushMode == BrushMode.Draw);

            // W/L 드래그 (우클릭 끌기)
            if (_isWLDragging && e.RightButton == MouseButtonState.Pressed)
            {
                double dx = pos.X - _wlStart.X;
                double dy = pos.Y - _wlStart.Y;
                _vm.WindowWidth  = Math.Max(1, _wlStartWidth  + dx * 4);
                _vm.WindowCenter = _wlStartCenter - dy * 2;
                Refresh();
            }

            // 팬 (중간버튼)
            if (_isPanning && e.MiddleButton == MouseButtonState.Pressed)
            {
                _translate.X += pos.X - _panStart.X;
                _translate.Y += pos.Y - _panStart.Y;
                _panStart = pos;
            }
        }

        private void Canvas_MouseDown(object sender, MouseButtonEventArgs e)
        {
            if (_vm == null) return;
            var pos = e.GetPosition(OverlayCanvas);
            OverlayCanvas.CaptureMouse();

            if (e.ChangedButton == MouseButton.Left)
                ApplyBrush(CanvasToImage(pos), _vm.BrushMode == BrushMode.Draw);

            if (e.ChangedButton == MouseButton.Right)
            {
                _isWLDragging = true;
                _wlStart = pos;
                _wlStartCenter = _vm.WindowCenter;
                _wlStartWidth  = _vm.WindowWidth;
            }

            if (e.ChangedButton == MouseButton.Middle)
            {
                _isPanning = true;
                _panStart = pos;
            }
        }

        private void Canvas_MouseUp(object sender, MouseButtonEventArgs e)
        {
            OverlayCanvas.ReleaseMouseCapture();
            if (e.ChangedButton == MouseButton.Right)  _isWLDragging = false;
            if (e.ChangedButton == MouseButton.Middle) _isPanning    = false;
        }

        private void Canvas_MouseLeave(object sender, MouseEventArgs e)
        {
            BrushCursor.Visibility = Visibility.Hidden;
            _isWLDragging = false;
            _isPanning    = false;
        }

        private void Canvas_MouseWheel(object sender, MouseWheelEventArgs e)
        {
            if (_vm == null) return;

            if (Keyboard.IsKeyDown(Key.LeftCtrl) || Keyboard.IsKeyDown(Key.RightCtrl))
            {
                // Ctrl+Scroll = 줌
                double factor = e.Delta > 0 ? 1.1 : 0.9;
                _scale.ScaleX = Math.Clamp(_scale.ScaleX * factor, 0.2, 10.0);
                _scale.ScaleY = _scale.ScaleX;
            }
            else
            {
                // 슬라이스 변경
                int delta = e.Delta > 0 ? -1 : 1;
                int next  = Math.Clamp(_vm.CurrentSliceIndex + delta, 0, _vm.Slices.Count - 1);
                if (next != _vm.CurrentSliceIndex)
                {
                    _vm.CurrentSliceIndex = next;
                    Refresh();
                }
            }
        }

        // ── 브러시 적용 ──────────────────────────────────────────────────
        private void ApplyBrush(Point imgPos, bool draw)
        {
            if (_vm?.CurrentSlice == null || _vm.LabelMap == null) return;

            var s = _vm.CurrentSlice;
            var activeMask = _vm.Masks.FirstOrDefault(m => m.Id == _vm.ActiveMaskId);
            if (activeMask == null) return;

            int cx = (int)imgPos.X, cy = (int)imgPos.Y;
            int r  = _vm.BrushSize;
            int w  = s.Width, h = s.Height;
            int offset = _vm.CurrentSliceIndex * w * h;

            for (int dy = -r; dy <= r; dy++)
            for (int dx = -r; dx <= r; dx++)
            {
                if (dx * dx + dy * dy > r * r) continue;
                int px = cx + dx, py = cy + dy;
                if (px < 0 || py < 0 || px >= w || py >= h) continue;

                int idx = py * w + px;
                if (draw)
                {
                    // HU 게이팅: 활성화된 경우에만 HU 범위 체크
                    short hu = s.PixelData[idx];
                    if (!_vm.GatePreviewActive ||
                        (hu >= _vm.BrushHuMin && hu <= _vm.BrushHuMax))
                    {
                        _vm.LabelMap[offset + idx] = activeMask.ColorIndex;
                    }
                }
                else
                {
                    _vm.LabelMap[offset + idx] = 0;
                }
            }

            Refresh();
        }

        // ── 좌표 변환 (Canvas → 이미지 픽셀) ────────────────────────────
        private Point CanvasToImage(Point canvasPos)
        {
            if (_bitmap == null) return canvasPos;

            double iw = DicomImage.ActualWidth,  ih = DicomImage.ActualHeight;
            double bw = _bitmap.PixelWidth,      bh = _bitmap.PixelHeight;
            if (iw == 0 || ih == 0) return canvasPos;

            // Stretch=Uniform 변환
            double scaleU = Math.Min(iw / bw, ih / bh);
            double offsetX = (iw - bw * scaleU) / 2;
            double offsetY = (ih - bh * scaleU) / 2;

            // 팬/줌 역변환
            double x = (canvasPos.X - _translate.X - offsetX) / (scaleU * _scale.ScaleX);
            double y = (canvasPos.Y - _translate.Y - offsetY) / (scaleU * _scale.ScaleY);
            return new Point(x, y);
        }

        // ── 브러시 커서 위치 업데이트 ────────────────────────────────────
        private void UpdateBrushCursor(Point pos)
        {
            if (_vm == null) return;
            double scaleU = DicomImage.ActualWidth > 0 && _bitmap != null
                ? Math.Min(DicomImage.ActualWidth / _bitmap.PixelWidth,
                           DicomImage.ActualHeight / _bitmap.PixelHeight)
                : 1.0;
            double r = _vm.BrushSize * scaleU * _scale.ScaleX;
            Canvas.SetLeft(BrushCursor, pos.X - r);
            Canvas.SetTop(BrushCursor,  pos.Y - r);
            BrushCursor.Width  = r * 2;
            BrushCursor.Height = r * 2;
            BrushCursor.Stroke = _vm.BrushMode == BrushMode.Draw
                ? Brushes.LimeGreen : Brushes.OrangeRed;
            BrushCursor.Visibility = Visibility.Visible;
        }

        // ── 공개: 뷰 리셋 ────────────────────────────────────────────────
        public void ResetView()
        {
            _scale.ScaleX = _scale.ScaleY = 1.0;
            _translate.X  = _translate.Y = 0;
        }
    }
}
