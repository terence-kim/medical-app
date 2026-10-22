using MediSeg.WPF.Helpers;
using MediSeg.WPF.ViewModels;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media.Imaging;

namespace MediSeg.WPF.Controls
{
    public partial class MprViewerControl : UserControl
    {
        private MainViewModel? _vm;
        private int _sagittalIdx, _coronalIdx;

        public MprViewerControl()
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
                    case nameof(MainViewModel.VolumeLoading):
                        Dispatcher.Invoke(UpdateLoadingState);
                        break;
                    case nameof(MainViewModel.Volume):
                        Dispatcher.Invoke(InitializeMpr);
                        break;
                    case nameof(MainViewModel.VolumeProgress):
                        Dispatcher.Invoke(() => MprProgressBar.Value = vm.VolumeProgress);
                        break;
                    case nameof(MainViewModel.CurrentSliceIndex):
                        Dispatcher.Invoke(RefreshAxial);
                        break;
                }
            };
        }

        private void UpdateLoadingState()
        {
            if (_vm == null) return;
            MprLoading.Visibility = _vm.VolumeLoading ? Visibility.Visible : Visibility.Collapsed;
        }

        private void InitializeMpr()
        {
            if (_vm?.Volume == null) return;
            _sagittalIdx = _vm.VolumeW / 2;
            _coronalIdx  = _vm.VolumeH / 2;
            RefreshAll();
        }

        private void RefreshAll()
        {
            RefreshAxial();
            RefreshSagittal();
            RefreshCoronal();
        }

        private void RefreshAxial()
        {
            if (_vm?.Volume == null) return;
            var bmp = DicomRenderHelper.RenderMprSlice(
                _vm.Volume, _vm.VolumeW, _vm.VolumeH, _vm.VolumeD,
                "axial", _vm.CurrentSliceIndex,
                _vm.WindowCenter, _vm.WindowWidth);
            AxialImage.Source = bmp;
            AxialSliceLabel.Text = $"z={_vm.CurrentSliceIndex}/{_vm.VolumeD}";
        }

        private void RefreshSagittal()
        {
            if (_vm?.Volume == null) return;
            SagittalImage.Source = DicomRenderHelper.RenderMprSlice(
                _vm.Volume, _vm.VolumeW, _vm.VolumeH, _vm.VolumeD,
                "sagittal", _sagittalIdx,
                _vm.WindowCenter, _vm.WindowWidth);
        }

        private void RefreshCoronal()
        {
            if (_vm?.Volume == null) return;
            CoronalImage.Source = DicomRenderHelper.RenderMprSlice(
                _vm.Volume, _vm.VolumeW, _vm.VolumeH, _vm.VolumeD,
                "coronal", _coronalIdx,
                _vm.WindowCenter, _vm.WindowWidth);
        }

        // 스크롤 이벤트
        private void Axial_MouseWheel(object sender, MouseWheelEventArgs e)
        {
            if (_vm == null) return;
            int next = Math.Clamp(_vm.CurrentSliceIndex + (e.Delta > 0 ? -1 : 1), 0, _vm.VolumeD - 1);
            _vm.CurrentSliceIndex = next;
            RefreshAxial();
        }

        private void Sagittal_MouseWheel(object sender, MouseWheelEventArgs e)
        {
            if (_vm == null) return;
            _sagittalIdx = Math.Clamp(_sagittalIdx + (e.Delta > 0 ? -1 : 1), 0, _vm.VolumeW - 1);
            RefreshSagittal();
        }

        private void Coronal_MouseWheel(object sender, MouseWheelEventArgs e)
        {
            if (_vm == null) return;
            _coronalIdx = Math.Clamp(_coronalIdx + (e.Delta > 0 ? -1 : 1), 0, _vm.VolumeH - 1);
            RefreshCoronal();
        }
    }
}
