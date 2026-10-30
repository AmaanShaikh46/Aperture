import importlib.util
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[1] / "extract_image_dataset.py"
spec = importlib.util.spec_from_file_location("extract_image_dataset", SCRIPT)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)


def hand(base_x=0.2):
    # Deterministic test landmarks with a unit wrist-to-middle-MCP distance.
    points = []
    for i in range(21):
        points.append(SimpleNamespace(x=base_x + (i % 5) * 0.01, y=0.1 + i * 0.01, z=i * 0.002))
    points[0] = SimpleNamespace(x=base_x, y=0.0, z=0.0)
    points[9] = SimpleNamespace(x=base_x, y=1.0, z=0.0)
    points[4] = SimpleNamespace(x=base_x + 0.3, y=0.8, z=0.0)
    return points


class FeaturePipelineTests(unittest.TestCase):
    def test_one_hand_layout_has_130_features_plus_label(self):
        row = module.build_feature_row([hand()], ["Right"], "A")
        self.assertEqual(len(row), 131)
        self.assertEqual(row[-1], "A")
        self.assertEqual(row[0:3], [0.0, 0.0, 0.0])
        self.assertEqual(row[63:126], [0.0] * 63)
        self.assertEqual(row[128:130], [-1.0, -1.0])

    def test_two_hand_detector_order_is_preserved(self):
        first = hand(0.75)
        second = hand(0.10)
        row = module.build_feature_row([first, second], ["Right", "Left"], "B")
        self.assertEqual(row[1], 0.0)
        self.assertEqual(row[64], 0.0)
        self.assertNotEqual(row[126:130], [-1.0] * 4)
        self.assertEqual(row[-1], "B")

    def test_rejects_no_hand(self):
        with self.assertRaises(ValueError):
            module.build_feature_row([], [], "A")

    def test_rejects_unknown_class(self):
        with self.assertRaises(ValueError):
            module.build_feature_row([hand()], ["Right"], "0")

    def test_recognises_official_dataset_split_names(self):
        self.assertEqual(module.infer_split(Path("Training (A-Z)/A/test.jpg")), "train")
        self.assertEqual(module.infer_split(Path("Validation/A/test.jpg")), "validation")
        self.assertEqual(module.infer_split(Path("Testing (A-Z)/A/test.jpg")), "test")


if __name__ == "__main__":
    unittest.main()
