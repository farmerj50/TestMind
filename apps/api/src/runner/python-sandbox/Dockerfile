FROM python@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
RUN python -m pip install --no-cache-dir --disable-pip-version-check \
    pytest==8.4.2 iniconfig==2.1.0 packaging==25.0 pluggy==1.6.0 pygments==2.19.2
COPY supervisor.py /opt/testmind/supervisor.py
RUN printf '[pytest]\n' > /opt/testmind/pytest.ini
ENV PYTHONDONTWRITEBYTECODE=1 PYTEST_DISABLE_PLUGIN_AUTOLOAD=1
USER 65532:65532
WORKDIR /work
LABEL testmind.pytest.protocol="1"
ENTRYPOINT ["python", "-I", "/opt/testmind/supervisor.py"]
