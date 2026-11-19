"""Offline Liblib contracts: signatures, uploads, polling, credential round trips."""
import base64
import io
import os
from unittest.mock import MagicMock, patch

import pytest
from PIL import Image
from fastapi import HTTPException

from app.image.liblib_generator import LiblibImageGenerator, sign_request, TEXT_PATH, UPLOAD_PATH
from app.providers.schema import AppSettings, ImageConfig, LLMConfig, mask_key
from app.providers.manager import ProviderManager
from app.providers.store import SettingsStore


def png_bytes():
    buffer = io.BytesIO()
    Image.new('RGB', (768, 1024), 'beige').save(buffer, 'PNG')
    return buffer.getvalue()


def generator(**kwargs):
    return LiblibImageGenerator('access-test-123456', 'secret-test-123456', poll_interval=0, **kwargs)


def response(data):
    resp = MagicMock(status_code=200)
    resp.json.return_value = {'code': 0, 'data': data}
    return resp


def test_signature_matches_independent_known_vector():
    # Cross-checked with Node crypto.createHmac('sha1', ...).digest('base64url').
    assert sign_request('/api/genImg', 'secret', '1725458584000', 'random1232') == 'zzwtvE6IuVrvPhdU63FqpAe0Lsc'


def test_poll_waits_through_review_and_downloads_durable_image():
    gen = generator()
    session = MagicMock()
    session.post.side_effect = [response({'generateUuid': 'task'}),
        response({'generateStatus': 3}), response({'generateStatus': 4}),
        response({'generateStatus': 5, 'images': [{'imageUrl': 'https://example.com/image.png', 'auditStatus': 3}]})]
    session.get.return_value.content = png_bytes()
    with patch.object(gen, '_session') as create, patch('app.image.liblib_generator.time.sleep'):
        create.return_value.__enter__.return_value = session
        result = gen.generate('A gold spoon on a beige table', size='1K', width=300, height=400)
    assert result.image_url.startswith('data:image/png;base64,')
    assert (result.width, result.height) == (300, 400)
    first = session.post.call_args_list[0]
    assert first.args[0].endswith(TEXT_PATH)
    assert first.kwargs['json']['generateParams']['imageSize'] == {'width': 768, 'height': 1024}
    assert 'secret-test' not in str(first.kwargs)
    assert len({call.kwargs['params']['SignatureNonce'] for call in session.post.call_args_list}) == 4


def test_local_upload_uses_oss_fields_and_subject_reference():
    gen = generator()
    session = MagicMock()
    signature = {'key': 'test/image.png', 'policy': 'p', 'postUrl': 'https://upload.example.com',
        'xOssDate': 'date', 'xOssExpires': 3600, 'xOssSignature': 'sig',
        'xOssCredential': 'cred', 'xOssSignatureVersion': 'OSS4-HMAC-SHA256'}
    session.post.side_effect = [response(signature), MagicMock(status_code=204),
        response({'generateUuid': 'task'}), response({'generateStatus': 5,
        'images': [{'imageUrl': 'https://example.com/result.png', 'auditStatus': 3}]})]
    session.get.return_value.content = png_bytes()
    ref = 'data:image/png;base64,' + base64.b64encode(png_bytes()).decode()
    with patch.object(gen, '_session') as create, patch('app.image.liblib_generator.time.sleep'):
        create.return_value.__enter__.return_value = session
        gen.variate(ref, 'A gold spoon on a table', size='1K')
    calls = session.post.call_args_list
    assert calls[0].args[0].endswith(UPLOAD_PATH)
    assert list(calls[1].kwargs['files']) == ['file']
    assert calls[1].kwargs['data']['x-oss-signature-version'] == 'OSS4-HMAC-SHA256'
    assert calls[2].kwargs['json']['generateParams']['controlnet'] == {
        'controlType': 'subject', 'controlImage': 'https://upload.example.com/test/image.png'}


@pytest.mark.parametrize('status,images', [(5, []), (6, []), (7, []), (5, [{'auditStatus': 4}])])
def test_failed_or_unapproved_result_never_returns_image(status, images):
    gen = generator()
    with patch.object(gen, '_session'), patch.object(gen, '_post', side_effect=[
            {'generateUuid': 'task'}, {'generateStatus': status, 'images': images}]), \
            patch('app.image.liblib_generator.time.sleep'):
        with pytest.raises(ValueError):
            gen.generate('A spoon', size='1K')


def test_does_not_retry_paid_submission_or_leak_signed_url():
    gen = generator()
    session = MagicMock()
    import requests
    session.post.side_effect = requests.Timeout('https://example.com?AccessKey=access-test-123456')
    with pytest.raises(ValueError) as error:
        gen._post(session, TEXT_PATH, {})
    assert 'access-test' not in str(error.value)
    assert session.post.call_count == 1


def test_unsupported_operations_fail_before_network():
    gen = generator()
    with patch.object(gen, '_session') as create:
        for action in (lambda: gen.generate('spoon', size='4K'),
                       lambda: gen.edit('https://example.com/a.png', 'spoon', mask='mask'),
                       lambda: gen.compose(['a', 'b'], 'spoon')):
            with pytest.raises(ValueError):
                action()
        create.assert_not_called()


@pytest.fixture
def routes_manager(tmp_path):
    from app.api import routes
    with patch.dict(os.environ, {key: '' for key in (
            'ARK_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'SILICONFLOW_API_KEY')}):
        manager = ProviderManager(SettingsStore(tmp_path / 'settings.json'))
        with patch.object(routes.deps, 'manager', manager):
            yield routes, manager


def test_secret_is_masked_and_restored_after_provider_switch(routes_manager):
    routes, manager = routes_manager
    settings = AppSettings(llm=LLMConfig(provider='mock'), image=ImageConfig(
        provider='liblib', api_key='access-test-123456', secret_key='secret-test-123456',
        base_url='https://openapi.liblibai.cloud', model='star-3-alpha', liblib_steps=20))
    manager.update(settings)
    public = routes._masked_settings()
    assert public['image']['secret_key'] == mask_key('secret-test-123456')
    profile = manager.profiles.list()['image'][0]
    assert profile['secret_key'] == public['image']['secret_key']
    manager.update(AppSettings(llm=LLMConfig(provider='mock')))
    req = routes.SettingsRequest(llm={'provider': 'mock'}, image={
        k: profile[k] for k in ('provider', 'api_key', 'secret_key', 'base_url', 'model', 'liblib_steps')})
    restored = routes._parse_settings(req)
    assert restored.image.secret_key == 'secret-test-123456'
    assert restored.image.liblib_steps == 20
    manager.update(restored)
    assert isinstance(manager.generator, LiblibImageGenerator)
    # Masked round trip must preserve the exact pair.
    assert routes._parse_settings(routes.SettingsRequest(**{
        k: public[k] for k in ('llm', 'image')})).image.secret_key == 'secret-test-123456'


def test_missing_secret_and_wrong_llm_provider_are_rejected(routes_manager):
    routes, _ = routes_manager
    with pytest.raises(HTTPException):
        routes._parse_settings(routes.SettingsRequest(llm={'provider': 'mock'}, image={
            'provider': 'liblib', 'api_key': 'access-test-123456'}))
    with pytest.raises(HTTPException):
        routes._parse_settings(routes.SettingsRequest(llm={'provider': 'liblib'}, image={}))


def test_liblib_connection_test_never_generates(routes_manager):
    routes, _ = routes_manager
    req = routes.SettingsRequest(llm={'provider': 'mock'}, image={
        'provider': 'liblib', 'api_key': 'access-test-123456', 'secret_key': 'secret-test-123456'})
    with patch.object(LiblibImageGenerator, '_post', return_value={}) as post:
        assert routes.test_settings(req)['image']['ok']
        assert post.call_args.args[1] == UPLOAD_PATH
