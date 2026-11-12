"""LocalHTTPServer logs real handler faults but not a browser hanging up."""

import pytest
import server

CLIENT = ("127.0.0.1", 50000)


@pytest.mark.parametrize("error", [BrokenPipeError(32, "Broken pipe"), ConnectionResetError()])
def test_client_disconnect_is_not_logged(capsys, error):
    local = server.LocalHTTPServer.__new__(server.LocalHTTPServer)
    try:
        raise error
    except OSError:
        local.handle_error(None, CLIENT)
    assert capsys.readouterr().err == ""


def test_handler_faults_are_still_logged(capsys):
    local = server.LocalHTTPServer.__new__(server.LocalHTTPServer)
    try:
        raise ValueError("real bug")
    except ValueError:
        local.handle_error(None, CLIENT)
    assert "ValueError: real bug" in capsys.readouterr().err
