from django.test import SimpleTestCase
from django.urls import reverse

class DiagnosticsUrlTests(SimpleTestCase):
    def test_diagnostics_urls_resolve(self):
        self.assertEqual(reverse("radio-diagnostics"), "/admin/radio-diagnostics/")
        self.assertEqual(reverse("radio-diagnostics-data"), "/admin/radio-diagnostics/data/")
