using MediSeg.WPF.Models;
using MediSeg.WPF.ViewModels;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Media;

namespace MediSeg.WPF.Controls
{
    public partial class MaskPanelControl : UserControl
    {
        private MainViewModel? _vm;
        private bool _suppressEvents;

        public MaskPanelControl()
        {
            InitializeComponent();
        }

        public void Bind(MainViewModel vm)
        {
            _vm = vm;
            vm.PropertyChanged += (s, e) =>
            {
                switch (e.PropertyName)
                {
                    case nameof(MainViewModel.Masks):
                    case nameof(MainViewModel.ActiveMaskId):
                    case nameof(MainViewModel.SelectedMaskIds):
                        Dispatcher.Invoke(RefreshMaskList);
                        break;
                    case nameof(MainViewModel.BrushHuMin):
                        Dispatcher.Invoke(() =>
                        {
                            _suppressEvents = true;
                            HuMinBox.Text = vm.BrushHuMin.ToString();
                            UpdateHuDisplay();
                            _suppressEvents = false;
                        });
                        break;
                    case nameof(MainViewModel.BrushHuMax):
                        Dispatcher.Invoke(() =>
                        {
                            _suppressEvents = true;
                            HuMaxBox.Text = vm.BrushHuMax.ToString();
                            UpdateHuDisplay();
                            _suppressEvents = false;
                        });
                        break;
                    case nameof(MainViewModel.BrushSize):
                        Dispatcher.Invoke(() =>
                        {
                            _suppressEvents = true;
                            BrushSizeSlider.Value = vm.BrushSize;
                            BrushSizeLabel.Text = vm.BrushSize.ToString();
                            _suppressEvents = false;
                        });
                        break;
                    case nameof(MainViewModel.FillProgress):
                        Dispatcher.Invoke(() =>
                        {
                            FillProgressBar.Visibility = vm.FillProgress > 0
                                ? Visibility.Visible : Visibility.Collapsed;
                            FillProgressBar.Value = vm.FillProgress;
                        });
                        break;
                    case nameof(MainViewModel.IsGenerating):
                        Dispatcher.Invoke(() =>
                        {
                            Generate3DBtn.IsEnabled = !vm.IsGenerating;
                            AISegBtn.IsEnabled      = !vm.IsGenerating;
                        });
                        break;
                }
            };

            RefreshMaskList();
        }

        private void RefreshMaskList()
        {
            if (_vm == null) return;

            var items = _vm.Masks.Select(m => new MaskListItem
            {
                Id         = m.Id,
                Label      = m.Label,
                Mask       = m,
                ColorBrush = new SolidColorBrush(m.Color),
                IsSelected = _vm.SelectedMaskIds.Contains(m.Id),
                LabelColor = new SolidColorBrush(
                    m.Id == _vm.ActiveMaskId ? Colors.White : Color.FromRgb(148,163,184))
            }).ToList();

            MaskList.ItemsSource = items;
        }

        private void UpdateHuDisplay()
        {
            HuRangeDisplay.Text = $"{_vm?.BrushHuMin} ~ {_vm?.BrushHuMax}";
        }

        // ── 이벤트 핸들러 ──────────────────────────────────────────────
        private void MaskButton_Click(object sender, RoutedEventArgs e)
        {
            if (_vm == null || sender is not Button btn) return;
            _vm.SetActiveMaskCommand.Execute(btn.Tag?.ToString());
        }

        private void VisibilityToggle_Click(object sender, RoutedEventArgs e)
        {
            if (_vm == null) return;
            _vm.RefreshTick++;
        }

        private void HuRange_Changed(object sender, TextChangedEventArgs e)
        {
            if (_suppressEvents || _vm == null) return;
            if (int.TryParse(HuMinBox.Text, out int min)) _vm.BrushHuMin = min;
            if (int.TryParse(HuMaxBox.Text, out int max)) _vm.BrushHuMax = max;
            UpdateHuDisplay();
            _vm.RefreshTick++;
        }

        private void SmartBrush_Click(object sender, RoutedEventArgs e)
        {
            if (_vm == null) return;
            _vm.GatePreviewActive = SmartBrushBtn.IsChecked == true;
            _vm.RefreshTick++;
        }

        private void Draw_Click(object sender, RoutedEventArgs e)
        {
            if (_vm == null) return;
            _vm.BrushMode = BrushMode.Draw;
            DrawBtn.Background  = new SolidColorBrush(Color.FromRgb(28, 58, 94));
            DrawBtn.BorderBrush = new SolidColorBrush(Color.FromRgb(59,130,246));
            EraseBtn.Background  = new SolidColorBrush(Color.FromRgb(30, 30, 56));
            EraseBtn.BorderBrush = new SolidColorBrush(Color.FromRgb(58, 58, 96));
        }

        private void Erase_Click(object sender, RoutedEventArgs e)
        {
            if (_vm == null) return;
            _vm.BrushMode = BrushMode.Erase;
            EraseBtn.Background  = new SolidColorBrush(Color.FromRgb(94, 28, 28));
            EraseBtn.BorderBrush = new SolidColorBrush(Color.FromRgb(239,68,68));
            DrawBtn.Background   = new SolidColorBrush(Color.FromRgb(30, 30, 56));
            DrawBtn.BorderBrush  = new SolidColorBrush(Color.FromRgb(58, 58, 96));
        }

        private void BrushSize_Changed(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            if (_suppressEvents || _vm == null) return;
            _vm.BrushSize = (int)BrushSizeSlider.Value;
            BrushSizeLabel.Text = _vm.BrushSize.ToString();
        }

        private void FillSlice_Click(object sender, RoutedEventArgs e)
            => _vm?.FillCurrentSliceCommand.Execute(null);

        private void FillAll_Click(object sender, RoutedEventArgs e)
            => _vm?.FillAllSlicesCommand.ExecuteAsync(null);

        private void Generate3D_Click(object sender, RoutedEventArgs e)
            => _vm?.GenerateModelCommand.Execute(null);

        private void AISeg_Click(object sender, RoutedEventArgs e)
            => _vm?.RunAISegmentationCommand.ExecuteAsync(null);

        private void Overlay_Click(object sender, RoutedEventArgs e)
        {
            if (_vm == null) return;
            _vm.SegOverlayOn = OverlayToggle.IsChecked == true;
            _vm.RefreshTick++;
        }
    }

    public class MaskListItem
    {
        public string Id            { get; set; } = "";
        public string Label         { get; set; } = "";
        public Mask Mask            { get; set; } = null!;
        public SolidColorBrush ColorBrush { get; set; } = new(Colors.White);
        public bool IsSelected      { get; set; }
        public SolidColorBrush LabelColor { get; set; } = new(Colors.White);
    }
}
