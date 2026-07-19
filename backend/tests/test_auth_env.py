import importlib
import sys
from types import ModuleType
from typing import cast

from _pytest.monkeypatch import MonkeyPatch


def _reload_auth_module() -> ModuleType:
    _ = sys.modules.pop("apo.auth", None)
    import apo.auth as auth_module

    return importlib.reload(auth_module)


class TestAuthSecretLoading:
    def test_auth_secret_wins_even_in_dev_mode(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("APO_DEV", "true")
        monkeypatch.setenv("AUTH_SECRET", "shared-secret")

        auth_module = _reload_auth_module()

        auth_secret = cast(str, getattr(auth_module, "AUTH_SECRET"))
        assert auth_secret == "shared-secret"

    def test_missing_auth_secret_stays_open_dev_mode(self, monkeypatch: MonkeyPatch) -> None:
        monkeypatch.setenv("AUTH_SECRET", "")
        monkeypatch.setenv("APO_DEV", "true")

        auth_module = _reload_auth_module()

        auth_secret = cast(str, getattr(auth_module, "AUTH_SECRET"))
        assert auth_secret == ""
