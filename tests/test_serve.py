import threading
import time

import serve


def test_password_is_stored_hashed_and_checked():
    stored = serve.hash_password("cheese-test-123")
    assert "cheese-test-123" not in str(stored)
    assert serve.check_password("cheese-test-123", stored)
    assert not serve.check_password("wrong", stored)


def test_sessions_expire_and_wrong_passwords_lock_out():
    s = serve.Sessions()
    t = s.new()
    assert s.valid(t) and not s.valid("made-up") and not s.valid(None)
    s.end(t)
    assert not s.valid(t)
    for _ in range(serve.MAX_FAILS):
        assert not s.locked("10.0.0.9")
        s.failed("10.0.0.9")
    assert s.locked("10.0.0.9") and not s.locked("10.0.0.8")


def test_relay_passes_a_question_to_the_page_and_the_answer_back():
    r = serve.Relay()
    assert not r.online()

    def page():      # the checker page on the office computer
        job = r.next(timeout=5)
        r.answer(job["id"], {"html": f"checked {job['args']['ids'][0]}"})

    threading.Thread(target=page).start()
    time.sleep(0.1)
    assert r.online()
    assert r.ask("check", {"ids": ["2484"]}, timeout=5) == {"html": "checked 2484"}


def test_relay_gives_up_when_nobody_picks_the_question_up():
    r = serve.Relay()
    t = time.time()
    assert r.ask("check", {"ids": ["1"]}, timeout=5, pickup=0.5) is None
    assert time.time() - t < 3 and not r.jobs
