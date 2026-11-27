using System.Windows;

namespace WpfFixture;

public partial class App : Application
{
}

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
    }

    private void OnSafeClick(object sender, RoutedEventArgs e)
    {
        StatusText.Text = "wpf-safe-clicked";
    }

    private void OnDeleteClick(object sender, RoutedEventArgs e)
    {
        StatusText.Text = "MUTATION_EXECUTED";
    }
}
