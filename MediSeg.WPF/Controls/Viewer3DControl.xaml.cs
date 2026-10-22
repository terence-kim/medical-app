using MediSeg.WPF.Helpers;
using MediSeg.WPF.Models;
using MediSeg.WPF.ViewModels;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Media3D;

namespace MediSeg.WPF.Controls
{
    public partial class Viewer3DControl : UserControl
    {
        private MainViewModel? _vm;
        private readonly Dictionary<byte, GeometryModel3D> _meshModels = new();

        // ── 카메라 제어 상태 ──────────────────────────────────────────
        private Point _lastMouse;
        private bool  _isRotating, _isPanning;
        private double _cameraDistance = 600;
        private double _cameraYaw   = -0.6;   // 수평 각도 (rad)
        private double _cameraPitch =  0.5;   // 수직 각도 (rad)
        private Point3D _cameraTarget = new(150, 150, 150); // 회전 중심

        public Viewer3DControl()
        {
            InitializeComponent();
        }

        public void Bind(MainViewModel vm)
        {
            _vm = vm;
            vm.PropertyChanged += (s, e) =>
            {
                if (e.PropertyName == nameof(MainViewModel.GenerateTick))
                    Dispatcher.InvokeAsync(GenerateAsync);
                if (e.PropertyName == nameof(MainViewModel.IsGenerating))
                    Dispatcher.Invoke(UpdateGeneratingState);
            };
        }

        private void UpdateGeneratingState()
        {
            if (_vm == null) return;
            GeneratingOverlay.Visibility = _vm.IsGenerating ? Visibility.Visible : Visibility.Collapsed;
        }

        // ── 3D 모델 생성 (Marching Cubes) ────────────────────────────
        private async Task GenerateAsync()
        {
            if (_vm?.LabelMap == null || _vm.Slices.Count == 0) return;

            _vm.IsGenerating = true;

            var selectedMasks = _vm.Masks
                .Where(m => _vm.SelectedMaskIds.Contains(m.Id))
                .ToList();

            if (selectedMasks.Count == 0) { _vm.IsGenerating = false; return; }

            int w = _vm.Slices[0].Width, h = _vm.Slices[0].Height, d = _vm.Slices.Count;
            double sx = _vm.CaseMeta?.PixelSpacingX ?? 1.0;
            double sy = _vm.CaseMeta?.PixelSpacingY ?? 1.0;
            double sz = _vm.CaseMeta?.SliceThickness ?? 1.0;
            var labelMap     = _vm.LabelMap;
            var targetLabels = selectedMasks.Select(m => m.ColorIndex).ToArray();

            Dictionary<byte, MeshGeometry3D> meshes = new();
            await Task.Run(() =>
                meshes = MarchingCubesHelper.ExtractMeshes(
                    labelMap, w, h, d, sx, sy, sz, targetLabels));

            UpdateModels(meshes, selectedMasks, w, h, d, sx, sy, sz);

            _vm.IsGenerating = false;
            _vm.ShowToast($"✅ 3D 생성 완료: {meshes.Count}개 장기");
        }

        private void UpdateModels(
            Dictionary<byte, MeshGeometry3D> meshes, List<Mask> masks,
            int w, int h, int d, double sx, double sy, double sz)
        {
            ModelContainer.Children.Clear();
            _meshModels.Clear();
            var legendItems = new List<LegendItem>();

            foreach (var mask in masks)
            {
                if (!meshes.TryGetValue(mask.ColorIndex, out var mesh)) continue;

                var mat     = new DiffuseMaterial(new SolidColorBrush(mask.Color) { Opacity = 0.88 });
                var backMat = new DiffuseMaterial(new SolidColorBrush(mask.Color) { Opacity = 0.4 });
                var model   = new GeometryModel3D(mesh, mat) { BackMaterial = backMat };
                var visual  = new ModelVisual3D { Content = model };
                ModelContainer.Children.Add(visual);
                _meshModels[mask.ColorIndex] = model;
                legendItems.Add(new LegendItem { Label = mask.Label, ColorBrush = new SolidColorBrush(mask.Color) });
            }

            LegendItems.ItemsSource = legendItems;
            EmptyState3D.Visibility = ModelContainer.Children.Count == 0
                ? Visibility.Visible : Visibility.Collapsed;

            // 카메라를 볼륨 중심으로 리셋
            _cameraTarget   = new Point3D(w * sx / 2, h * sy / 2, d * sz / 2);
            _cameraDistance = Math.Max(w * sx, Math.Max(h * sy, d * sz)) * 1.5;
            _cameraYaw   = -0.6;
            _cameraPitch =  0.5;
            UpdateCamera();
        }

        // ── 카메라 업데이트 ───────────────────────────────────────────
        private void UpdateCamera()
        {
            double sinY = Math.Sin(_cameraYaw),   cosY = Math.Cos(_cameraYaw);
            double sinP = Math.Sin(_cameraPitch),  cosP = Math.Cos(_cameraPitch);

            var pos = new Point3D(
                _cameraTarget.X + _cameraDistance * cosP * sinY,
                _cameraTarget.Y + _cameraDistance * sinP,
                _cameraTarget.Z + _cameraDistance * cosP * cosY);

            Camera.Position = pos;
            Camera.LookDirection = new Vector3D(
                _cameraTarget.X - pos.X,
                _cameraTarget.Y - pos.Y,
                _cameraTarget.Z - pos.Z);
        }

        // ── 마우스 카메라 제어 ────────────────────────────────────────
        private void Viewport_MouseDown(object sender, MouseButtonEventArgs e)
        {
            _lastMouse = e.GetPosition(this);
            if (e.ChangedButton == MouseButton.Left)  { _isRotating = true; Viewport.CaptureMouse(); }
            if (e.ChangedButton == MouseButton.Right) { _isPanning  = true; Viewport.CaptureMouse(); }
        }

        private void Viewport_MouseMove(object sender, MouseEventArgs e)
        {
            var pos = e.GetPosition(this);
            double dx = pos.X - _lastMouse.X;
            double dy = pos.Y - _lastMouse.Y;
            _lastMouse = pos;

            if (_isRotating)
            {
                _cameraYaw   -= dx * 0.005;
                _cameraPitch  = Math.Clamp(_cameraPitch + dy * 0.005, -1.5, 1.5);
                UpdateCamera();
            }
            if (_isPanning)
            {
                // 팬: 카메라 우/상 방향으로 타겟 이동
                var right = Vector3D.CrossProduct(Camera.LookDirection, Camera.UpDirection);
                right.Normalize();
                double scale = _cameraDistance * 0.001;
                _cameraTarget.Offset(-right.X * dx * scale,  right.Y * dy * scale, 0);
                UpdateCamera();
            }
        }

        private void Viewport_MouseUp(object sender, MouseButtonEventArgs e)
        {
            _isRotating = _isPanning = false;
            Viewport.ReleaseMouseCapture();
        }

        private void Viewport_MouseWheel(object sender, MouseWheelEventArgs e)
        {
            _cameraDistance = Math.Max(10, _cameraDistance * (e.Delta > 0 ? 0.85 : 1.18));
            UpdateCamera();
        }

        // ── 장기 가시성 업데이트 ──────────────────────────────────────
        public void UpdateVisibility(IEnumerable<string> visibleIds)
        {
            if (_vm == null) return;
            foreach (var mask in _vm.Masks)
            {
                if (_meshModels.TryGetValue(mask.ColorIndex, out var model))
                    model.Material = visibleIds.Contains(mask.Id)
                        ? new DiffuseMaterial(new SolidColorBrush(mask.Color) { Opacity = 0.88 })
                        : new DiffuseMaterial(Brushes.Transparent);
            }
        }
    }

    public class LegendItem
    {
        public string Label               { get; set; } = "";
        public SolidColorBrush ColorBrush { get; set; } = new(Colors.White);
    }
}
